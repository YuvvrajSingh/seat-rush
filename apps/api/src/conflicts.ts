import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { PrismaClient } from "@seatrush/db";
import { ConflictWindowSchema, PUBSUB_CHANNELS, type ConflictWindow } from "@seatrush/shared";

export interface ConflictPublisher {
  publish(channel: string, payload: string): Promise<unknown>;
}

export interface ConflictChannel {
  /** Supply only the conflicting ids returned by the deciding database statement. No I/O. */
  record(screeningId: string, seatIds: readonly string[]): void;
  /** Close the partial window and persist every pending batch; publication is best-effort/live-only. */
  flush(): Promise<void>;
  /** Stop accepting records and flush before disconnecting Postgres or Redis. */
  close(): Promise<void>;
}

interface SeatCount {
  screeningId: string;
  seatId: string;
  count: number;
}
interface PendingBatch {
  input: string;
}

// Pub/sub is not a replay log. Bound the live publication work retained during a drain,
// even if many durable batches accumulated while PostgreSQL was unavailable.
const MAX_LIVE_PUBLICATIONS = 1_000;

interface ConflictChannelOptions {
  prisma: PrismaClient;
  publisher: ConflictPublisher;
  logger: Pick<Logger, "error">;
  windowMs?: number;
  channel?: string;
}

/**
 * Each rejected request contributes once per distinct reported seat. Windows normally span
 * 100 ms; an explicit flush closes the current interval early. Buffering never touches ownership
 * rows or the ownership-event cursor. Failed persistence retains stable ids for a safe retry;
 * publication happens only after all pending batches are durable and is never retried.
 */
export function createConflictChannel({
  prisma, publisher, logger, windowMs = 100, channel = PUBSUB_CHANNELS.conflicts,
}: ConflictChannelOptions): ConflictChannel {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 2_147_483_647) {
    throw new Error("Conflict windowMs must be a positive timer-safe integer");
  }

  const active = new Map<string, SeatCount>();
  const pending: PendingBatch[] = [];
  let pendingIndex = 0;
  let windowStartedAt: number | undefined;
  let windowEndsAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let flushTail = Promise.resolve();

  function seal(endedAt: number) {
    if (windowStartedAt === undefined) return;
    const startedAt = new Date(windowStartedAt).toISOString();
    const finishedAt = new Date(Math.max(windowStartedAt, Math.min(endedAt, windowEndsAt))).toISOString();
    pending.push({
      input: JSON.stringify(Array.from(active.values(), (seat) => ({
        ...seat, id: randomUUID(), windowStartedAt: startedAt, windowEndedAt: finishedAt,
      }))),
    });
    active.clear();
    windowStartedAt = undefined;
  }

  async function persist(batch: PendingBatch) {
    // Stable UUIDs plus ON CONFLICT make a repeated flush safe even if a previous INSERT
    // committed but its response was lost. The CTE returns both newly inserted and existing rows.
    const rows = await prisma.$queryRaw<{ window: unknown }[]>`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${batch.input}::jsonb) AS x(
          id uuid, "screeningId" uuid, "seatId" uuid, count integer,
          "windowStartedAt" timestamptz, "windowEndedAt" timestamptz)
      ), inserted AS (
        INSERT INTO conflict_windows (id, screening_id, seat_id, count, window_started_at, window_ended_at)
        SELECT id, "screeningId", "seatId", count, "windowStartedAt", "windowEndedAt" FROM input ORDER BY "seatId"
        ON CONFLICT (id) DO NOTHING RETURNING *
      )
      SELECT jsonb_build_object('id', id, 'kind', 'seat.conflict', 'screeningId', screening_id,
        'seatId', seat_id, 'count', count, 'windowStartedAt', window_started_at,
        'windowEndedAt', window_ended_at, 'at', created_at) AS window
      FROM (
        SELECT * FROM inserted
        UNION ALL
        SELECT saved.* FROM conflict_windows saved JOIN input ON input.id = saved.id
      ) windows ORDER BY screening_id, seat_id, id`;
    return rows.map((row) => {
      const window = ConflictWindowSchema.parse(row.window);
      return {
        ...window,
        windowStartedAt: new Date(window.windowStartedAt).toISOString(),
        windowEndedAt: new Date(window.windowEndedAt).toISOString(),
        at: new Date(window.at).toISOString(),
      };
    });
  }

  function drain() {
    // Serialization includes callers arriving while a flush is in flight. Do not let an earlier
    // rejection poison the chain: persistence failures reach the caller and remain queued.
    const result = flushTail.then(async () => {
      const publications: ConflictWindow[] = [];
      try {
        // Redis must never stop later batches from reaching PostgreSQL.
        while (pendingIndex < pending.length) {
          const windows = await persist(pending[pendingIndex]!);
          pendingIndex++;
          for (const window of windows) {
            if (publications.length < MAX_LIVE_PUBLICATIONS) publications.push(window);
          }
        }
      } finally {
        // Release durable batches even if a later database operation fails. Only unpersisted
        // work is retained; live publications are deliberately lost on any interrupted drain.
        pending.splice(0, pendingIndex);
        pendingIndex = 0;
      }
      for (const window of publications) {
        try {
          await publisher.publish(channel, JSON.stringify(window));
        } catch (err) {
          logger.error({ err }, "Conflict publication failed; dropping remaining live windows");
          break;
        }
      }
    });
    flushTail = result.catch(() => {});
    return result;
  }

  function schedule(delay?: number) {
    if (closed || timer !== undefined || (active.size === 0 && pendingIndex === pending.length)) return;
    const wait = delay ?? (pendingIndex < pending.length ? 0 : Math.max(0, windowEndsAt - Date.now()));
    timer = setTimeout(() => {
      timer = undefined;
      if (windowStartedAt !== undefined && Date.now() >= windowEndsAt) seal(windowEndsAt);
      void drain().then(() => schedule(), (err: unknown) => {
        logger.error({ err }, "Conflict window flush failed; pending work retained");
        // A newly opened window must still close on time. Without new records, explicit flush/
        // shutdown is the next attempt; do not spin on unavailable infrastructure.
        if (active.size > 0) schedule(Math.max(1, windowEndsAt - Date.now()));
      });
    }, wait);
    timer.unref();
  }

  function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    seal(Date.now());
    return drain();
  }

  return {
    record(screeningId, seatIds) {
      if (closed) throw new Error("Conflict channel is closed");
      if (seatIds.length === 0) return;
      const now = Date.now();
      if (windowStartedAt !== undefined && now >= windowEndsAt) seal(windowEndsAt);
      if (windowStartedAt === undefined) {
        windowStartedAt = now;
        windowEndsAt = now + windowMs;
      }
      for (const seatId of new Set(seatIds)) {
        const key = `${screeningId}:${seatId}`;
        const existing = active.get(key);
        if (existing) existing.count++;
        else active.set(key, { screeningId, seatId, count: 1 });
      }
      schedule();
    },
    flush,
    close() {
      closed = true;
      return flush();
    },
  };
}
