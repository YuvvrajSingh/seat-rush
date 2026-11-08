import { DelayedError, Queue, UnrecoverableError, type ConnectionOptions, type Job } from "bullmq";
import type { Logger } from "pino";
import { cleanupExpiredHoldInTransaction, emitHoldEvent, type PrismaClient } from "@seatrush/db";
import { HoldParamsSchema, QUEUE_NAMES } from "@seatrush/shared";

/** Queue delivery is only a wake-up: the SQL function decides expiry using now(). */
async function expireHold(db: PrismaClient, holdId: string): Promise<{ cleared: number; expiresAt?: Date }> {
  return db.$transaction(async (tx) => {
    const seats = await cleanupExpiredHoldInTransaction(tx, holdId);
    if (seats.length === 0) {
      // Delivery can precede the deciding database clock; retain the wake-up for a live hold.
      const [live] = await tx.$queryRaw<{ expiresAt: Date }[]>`
        SELECT expires_at AS "expiresAt" FROM holds
        WHERE id = ${holdId}::uuid AND status = 'active' AND expires_at > now()`;
      return live ? { cleared: 0, expiresAt: live.expiresAt } : { cleared: 0 };
    }
    const [hold] = await tx.$queryRaw<{
      id: string;
      screeningId: string;
      customerId: string;
      expiresAt: Date;
    }[]>`
      SELECT id, screening_id AS "screeningId", customer_id AS "customerId", expires_at AS "expiresAt"
      FROM holds WHERE id = ${holdId}::uuid`;
    if (!hold) throw new Error("Expired hold disappeared inside its transaction");
    // Historical hold_items can include seats already reclaimed by a newer owner.
    // Keep the event INSERT last: no SQL may acquire another lock after its cursor lock.
    await emitHoldEvent(tx, "hold.expired", { ...hold, seats, expiresAt: hold.expiresAt.toISOString() }, hold.customerId);
    return { cleared: seats.length };
  }, { maxWait: 30_000, timeout: 30_000 });
}

/** Each hold has its own transaction: ownership locks always precede the event cursor lock. */
export async function processExpiryJob(db: PrismaClient, job: Job, token: string | undefined, logger: Logger): Promise<number> {
  if (job.name !== "sweep") {
    const parsed = HoldParamsSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError("Invalid expiry job: holdId must be a UUID");
    const result = await expireHold(db, parsed.data.holdId);
    if (result.expiresAt) {
      await job.moveToDelayed(result.expiresAt.getTime() + 250, token);
      throw new DelayedError();
    }
    return result.cleared;
  }
  const expired = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM holds WHERE status = 'active' AND expires_at <= now() ORDER BY expires_at, id LIMIT 500`;
  let cleared = 0;
  for (const hold of expired) {
    try {
      cleared += (await expireHold(db, hold.id)).cleared;
    } catch (err) {
      logger.error({ err, holdId: hold.id }, "expiry sweep could not clean hold");
    }
  }
  // Retention uses the database clock. Do not interrupt a live lease or an execution
  // holding its fencing row lock, even if its original retention/lease has elapsed.
  try {
    await db.$executeRaw`
      WITH expired_records AS (
        SELECT id FROM idempotency_records
        WHERE retain_until < now() AND (status = 'completed' OR locked_until < now())
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM idempotency_records r USING expired_records expired WHERE r.id = expired.id`;
  } catch (err) {
    logger.error({ err }, "expiry sweep could not purge idempotency retention");
  }
  return cleared;
}

interface ExpirySweepOptions {
  connection: ConnectionOptions;
  logger: Logger;
  prefix?: string;
  /** Production reconciles every 30s; tests shorten the interval against real Redis. */
  intervalMs?: number;
}

export interface ExpirySweep {
  close(): Promise<void>;
}

/**
 * A repeatable BullMQ sweep repairs missed delayed jobs after producer/Redis outages (FR-03).
 * Reinstalling the scheduler periodically also repairs Redis data loss without a worker restart.
 */
export async function startExpirySweep({ connection, logger, prefix, intervalMs = 30_000 }: ExpirySweepOptions): Promise<ExpirySweep> {
  const queue = new Queue(QUEUE_NAMES.holdExpiry, { connection, ...(prefix === undefined ? {} : { prefix }) });
  let connectionFailed = false;
  queue.on("error", (err) => {
    if (connectionFailed) return;
    connectionFailed = true;
    logger.warn({ err }, "expiry sweep queue error");
  });
  queue.getBackend().on("ready", () => { connectionFailed = false; });
  let schedulerFailed = false;
  let pending: Promise<void> | undefined;
  let closed = false;
  function ensureScheduler(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = queue.upsertJobScheduler("expiry-sweep", { every: intervalMs }, {
      name: "sweep", data: {}, opts: { removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 1_000 } },
    }).then(() => { schedulerFailed = false; }, (err: unknown) => {
      if (schedulerFailed) return;
      schedulerFailed = true;
      logger.warn({ err }, "could not register expiry sweep; will retry");
    })
      .finally(() => { pending = undefined; });
    return pending;
  }
  await ensureScheduler();
  const timer = setInterval(() => { void ensureScheduler(); }, intervalMs);
  timer.unref();
  return {
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      await pending;
      await queue.close();
    },
  };
}
