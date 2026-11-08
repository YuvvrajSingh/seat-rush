import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Queue, type Job, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSeatsInTransaction, cleanupExpiredHoldInTransaction, createPrismaClient, emitHoldEvent } from "@seatrush/db";
import { HoldSchema, QUEUE_NAMES, SeatEventSchema } from "@seatrush/shared";
import { createProcessors } from "../src/processors.js";
import { startExpirySweep } from "../src/expiry.js";
import { startWorkers } from "../src/workers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || databaseUrl === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
if (!redisUrl) throw new Error("REDIS_URL is required for real Redis tests");
const prisma = createPrismaClient(databaseUrl);
const logger = pino({ level: "silent" });
const cleanup: (() => Promise<unknown>)[] = [];
let screeningId: string;
let customerIds: string[];
let seatIds: string[];

beforeEach(async () => {
  const fixture = randomUUID();
  const screening = await prisma.screening.create({ data: {
    title: `Expiry ${fixture}`, startsAt: new Date("2030-01-01T12:00:00Z"), durationMinutes: 180, seatPricePaise: 25_000,
    seats: { create: [{ label: "A1", row: "A", number: 1 }, { label: "A2", row: "A", number: 2 }] },
  }, include: { seats: { orderBy: { number: "asc" } } } });
  screeningId = screening.id;
  seatIds = screening.seats.map((seat) => seat.id);
  const customers = await Promise.all([0, 1].map((index) => prisma.identity.create({ data: {
    demoKey: `expiry-${fixture}-${index}`, displayName: `Expiry ${index}`, role: "customer",
  } })));
  customerIds = customers.map((customer) => customer.id);
});

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
  await prisma.seat.deleteMany({ where: { screeningId } });
  await prisma.screening.delete({ where: { id: screeningId } });
  await prisma.identity.deleteMany({ where: { id: { in: customerIds } } });
});
afterAll(async () => { await prisma.$disconnect(); });

async function claim(customer = 0, seats = seatIds, db = prisma) {
  return db.$transaction(async (tx) => {
    const claimed = await claimSeatsInTransaction(tx, { screeningId, customerId: customerIds[customer]!, seatIds: seats });
    const hold = HoldSchema.parse({ ...claimed, status: "active", createdAt: claimed.createdAt.toISOString(), expiresAt: claimed.expiresAt.toISOString() });
    await emitHoldEvent(tx, "hold.created", hold, customerIds[customer]!);
    return hold;
  });
}

async function expire(holdId: string) {
  // Move both timestamps back without extending the database's five-minute window.
  await prisma.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
    expires_at = expires_at - interval '5 minutes' WHERE id = ${holdId}::uuid`;
}

async function startQueue(workerCount = 1, db = prisma) {
  const prefix = `expiry-test-${randomUUID()}`;
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  cleanup.push(() => connection.quit());
  const queue = new Queue(QUEUE_NAMES.holdExpiry, { connection, prefix });
  cleanup.push(async () => { await queue.obliterate({ force: true }); await queue.close(); });
  const workers: Worker[] = [];
  for (let index = 0; index < workerCount; index++) {
    workers.push(...startWorkers({ processors: createProcessors(db, logger), connection, logger, prefix }));
  }
  cleanup.push(() => Promise.all(workers.map((worker) => worker.close())));
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  return { queue, connection, prefix, workers };
}

async function completed(job: Job) {
  await expect.poll(() => job.getState(), { timeout: 10_000 }).toBe("completed");
}

function expiredEvents() {
  return prisma.domainEvent.findMany({ where: { screeningId, kind: "hold.expired" }, orderBy: { id: "asc" } });
}

describe("hold expiry through real BullMQ and Postgres", () => {
  it("runs a delayed holdId job, clears its seats and commits one strict ordered expiration event", async () => {
    const hold = await claim();
    await expire(hold.id);
    const { queue } = await startQueue();
    const job = await queue.add("expire", { holdId: hold.id }, { delay: 1_000 });
    expect(await job.getState()).toBe("delayed");
    await completed(job);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("expired");
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: { not: null } } })).toBe(0);
    const [stored] = await expiredEvents();
    expect(stored).toBeDefined();
    const event = SeatEventSchema.parse(stored!.payload);
    expect(event).toEqual({
      id: stored!.id.toString(), kind: "hold.expired", screeningId, holdId: hold.id, seats: hold.seats,
      at: stored!.createdAt.toISOString(),
    });
    expect(stored!.customerId).toBe(customerIds[0]);
    const created = await prisma.domainEvent.findFirstOrThrow({ where: { screeningId, kind: "hold.created" } });
    expect(stored!.id).toBeGreaterThan(created.id);
    const cursor = await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } });
    expect(cursor.lastEventId).toBe(stored!.id);
  });

  it("is safe to process twice and never emits a second expiration", async () => {
    const hold = await claim();
    await expire(hold.id);
    const { queue } = await startQueue();
    await completed(await queue.add("expire", { holdId: hold.id }));
    await completed(await queue.add("expire", { holdId: hold.id }));
    expect(await expiredEvents()).toHaveLength(1);
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: { not: null } } })).toBe(0);
  });

  it("leaves a newer hold and its event cursor unchanged when an old job arrives late", async () => {
    const old = await claim();
    await expire(old.id);
    const current = await claim(1);
    const before = await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } });
    const { queue } = await startQueue();
    await completed(await queue.add("expire", { holdId: old.id }));
    await completed(await queue.add("expire", { holdId: old.id }));
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: current.id } })).toBe(2);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: current.id } })).status).toBe("active");
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("expired");
    expect(await expiredEvents()).toHaveLength(0);
    expect((await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } })).lastEventId).toBe(before.lastEventId);
  });

  it("reports only seats actually cleared when a newer hold reclaimed part of an expired hold", async () => {
    const old = await claim();
    await expire(old.id);
    const current = await claim(1, [seatIds[0]!]);
    const { queue } = await startQueue();
    await completed(await queue.add("expire", { holdId: old.id }));
    const events = await expiredEvents();
    expect(events).toHaveLength(1);
    expect(SeatEventSchema.parse(events[0]!.payload)).toMatchObject({
      kind: "hold.expired", holdId: old.id, seats: [{ id: seatIds[1], label: "A2" }],
    });
    expect(await prisma.seat.findUniqueOrThrow({ where: { id: seatIds[0]! } })).toMatchObject({ currentHoldId: current.id });
    expect(await prisma.seat.findUniqueOrThrow({ where: { id: seatIds[1]! } })).toMatchObject({ currentHoldId: null });
  });

  it("reschedules an early job using database expiry, then expires it without a sweep", async () => {
    const hold = await claim();
    const { queue } = await startQueue();
    // Preserve the five-minute window but bring its database deadline close enough to observe.
    await prisma.$executeRaw`UPDATE holds SET created_at = now() - interval '5 minutes' + interval '3 seconds',
      expires_at = now() + interval '3 seconds' WHERE id = ${hold.id}::uuid`;
    const stored = await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } });
    const job = await queue.add("expire", { holdId: hold.id }, { attempts: 1 });
    await expect.poll(() => job.getState(), { timeout: 2_000 }).toBe("delayed");
    const rescheduled = await queue.getJob(job.id!);
    expect(rescheduled!.delay).toBeGreaterThan(0);
    expect(rescheduled!.delay).toBeLessThanOrEqual(stored.expiresAt.getTime() + 250 - rescheduled!.timestamp);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("active");
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: hold.id } })).toBe(2);
    expect(await expiredEvents()).toHaveLength(0);
    await completed(job);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("expired");
    expect(await expiredEvents()).toHaveLength(1);
    expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1);
  });

  it.each([{}, { holdId: "not-a-uuid" }, { holdId: 42 }, null])("rejects malformed expiry data without retries: %j", async (data) => {
    const { queue } = await startQueue();
    const job = await queue.add("expire", data, { attempts: 3, backoff: { type: "fixed", delay: 50 } });
    await expect.poll(() => job.getState(), { timeout: 10_000 }).toBe("failed");
    const failed = await queue.getJob(job.id!);
    expect(failed!.attemptsMade).toBe(1);
    expect(failed!.failedReason).toBe("Invalid expiry job: holdId must be a UUID");
    expect(await expiredEvents()).toHaveLength(0);
  });

  it("the repeatable sweep recovers a lost delayed job and can process the next expiry", async () => {
    const first = await claim();
    const { queue, connection, prefix } = await startQueue();
    const lost = await queue.add("expire", { holdId: first.id }, { delay: 300_000 });
    await lost.remove();
    expect(await queue.getJob(lost.id!)).toBeUndefined();
    await expire(first.id);
    const sweep = await startExpirySweep({ connection, logger, prefix, intervalMs: 100 });
    cleanup.push(() => sweep.close());
    await expect.poll(async () => (await expiredEvents()).length, { timeout: 10_000 }).toBe(1);
    const second = await claim(1);
    await expire(second.id);
    await expect.poll(async () => (await expiredEvents()).length, { timeout: 10_000 }).toBe(2);
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: { not: null } } })).toBe(0);
  });

  it("reinstalls the repeatable sweep after Redis queue data is lost", async () => {
    const { queue, connection, prefix } = await startQueue();
    const sweep = await startExpirySweep({ connection, logger, prefix, intervalMs: 100 });
    cleanup.push(() => sweep.close());
    await queue.obliterate({ force: true });
    const hold = await claim();
    await expire(hold.id);
    await expect.poll(async () => (await expiredEvents()).length, { timeout: 10_000 }).toBe(1);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("expired");
  });

  it("purges expired idempotency retention on sweeps without deleting live leases or retained responses", async () => {
    const createRecord = (key: string, completed: boolean, associated = true) => prisma.idempotencyRecord.create({ data: {
      customerId: customerIds[0]!, screeningId: associated ? screeningId : null,
      operation: "hold.create", key: `${screeningId}-${key}`, requestHash: "retention-test",
      ...(completed ? { status: "completed", responseCode: 409, responseBody: { error: "seat_unavailable" } } : {}),
    } });
    const expiredResponse = await createRecord("expired-response", true);
    const abandoned = await createRecord("abandoned", false);
    const liveLease = await createRecord("live-lease", false);
    const retainedResponse = await createRecord("retained-response", true);
    const retainedStale = await createRecord("retained-stale", false);
    const unassociated = await createRecord("unassociated", true, false);
    cleanup.push(() => prisma.idempotencyRecord.deleteMany({ where: { customerId: { in: customerIds } } }));
    await prisma.$executeRaw`UPDATE idempotency_records SET
      created_at = now() - interval '25 hours', retain_until = now() - interval '1 hour',
      locked_until = CASE WHEN id = ${liveLease.id}::uuid THEN now() + interval '1 hour' ELSE now() - interval '1 hour' END
      WHERE id = ANY(${[expiredResponse.id, abandoned.id, liveLease.id, unassociated.id]}::uuid[])`;
    await prisma.$executeRaw`UPDATE idempotency_records SET locked_until = now() - interval '1 hour'
      WHERE id = ${retainedStale.id}::uuid`;
    const { queue } = await startQueue();
    await completed(await queue.add("sweep", {}));
    expect((await prisma.idempotencyRecord.findMany({
      where: { customerId: customerIds[0]! }, orderBy: { id: "asc" }, select: { id: true },
    })).map((record) => record.id).sort()).toEqual([liveLease.id, retainedResponse.id, retainedStale.id].sort());
    await prisma.$executeRaw`UPDATE idempotency_records SET locked_until = now() - interval '1 second'
      WHERE id = ${liveLease.id}::uuid`;
    await completed(await queue.add("sweep", {}));
    expect(await prisma.idempotencyRecord.findUnique({ where: { id: liveLease.id } })).toBeNull();
  });

  it("skips expired retention locked by a running execution and preserves its completed response", async () => {
    const record = await prisma.idempotencyRecord.create({ data: {
      screeningId, customerId: customerIds[0]!, operation: "hold.create", key: randomUUID(), requestHash: "executing",
    } });
    await prisma.$executeRaw`UPDATE idempotency_records SET created_at = now() - interval '25 hours',
      retain_until = now() - interval '1 hour', locked_until = now() - interval '1 second'
      WHERE id = ${record.id}::uuid`;
    const { queue } = await startQueue();
    const locked = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const execution = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM idempotency_records WHERE id = ${record.id}::uuid FOR UPDATE`;
      locked.resolve();
      await finish.promise;
      await tx.$executeRaw`UPDATE idempotency_records SET status = 'completed', response_code = 409,
        response_body = '{"error":"seat_unavailable"}'::jsonb, retain_until = now() + interval '24 hours'
        WHERE id = ${record.id}::uuid`;
    }, { timeout: 15_000 });
    try {
      await Promise.race([locked.promise, execution]);
      await completed(await queue.add("sweep", {}));
      expect(await prisma.idempotencyRecord.findUnique({ where: { id: record.id } })).not.toBeNull();
    } finally {
      finish.resolve();
      await execution;
    }
    await completed(await queue.add("sweep", {}));
    expect(await prisma.idempotencyRecord.findUnique({ where: { id: record.id } })).toMatchObject({
      status: "completed", responseCode: 409, responseBody: { error: "seat_unavailable" },
    });
  });

  it("rolls back ownership and the ordered cursor when the shared emitter rejects an invalid payload", async () => {
    const hold = await claim();
    await expire(hold.id);
    const before = await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } });
    await expect(prisma.$transaction(async (tx) => {
      await cleanupExpiredHoldInTransaction(tx, hold.id);
      await emitHoldEvent(tx, "hold.expired", { ...hold, seats: [] }, customerIds[0]!);
    })).rejects.toThrow();
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("active");
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: hold.id } })).toBe(2);
    expect(await expiredEvents()).toHaveLength(0);
    expect((await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } })).lastEventId).toBe(before.lastEventId);
  });

  it("keeps pg_stat_database.deadlocks flat during concurrent expiry-versus-reclaim bursts", async () => {
    const extraSeats = await Promise.all(Array.from({ length: 18 }, (_, index) => prisma.seat.create({ data: {
      screeningId, label: `${index < 10 ? "B" : "C"}${index % 10 + 1}`, row: index < 10 ? "B" : "C", number: index % 10 + 1,
    } })));
    const inventory = [...seatIds, ...extraSeats.map((seat) => seat.id)];
    const extraCustomers = await Promise.all(Array.from({ length: 18 }, (_, index) => prisma.identity.create({ data: {
      demoKey: `expiry-burst-${randomUUID()}`, displayName: `Burst ${index}`, role: "customer",
    } })));
    customerIds.push(...extraCustomers.map((customer) => customer.id));
    const groups = Array.from({ length: 10 }, (_, index) => inventory.slice(index * 2, index * 2 + 2));
    const burstDb = createPrismaClient(databaseUrl!);
    cleanup.push(() => burstDb.$disconnect());
    const { queue, workers } = await startQueue(10, burstDb);
    const deadlocks = () => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
      const [stats] = await tx.$queryRaw<{ deadlocks: bigint }[]>`
        SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
      return stats!.deadlocks;
    });
    const before = await deadlocks();
    let current = await Promise.all(groups.map((group, index) => claim(index, group, burstDb)));
    for (let round = 0; round < 10; round++) {
      await burstDb.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
        expires_at = expires_at - interval '5 minutes' WHERE id = ANY(${current.map((hold) => hold.id)}::uuid[])`;
      const offset = round % 2 === 0 ? 10 : 0;
      const outcomes = await Promise.all(groups.map(async (group, index) => {
        const [job, next] = await Promise.all([
          queue.add("expire", { holdId: current[index]!.id }, { attempts: 1 }),
          claim(offset + index, group.toReversed(), burstDb),
        ]);
        await completed(job);
        expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1);
        expect(await prisma.seat.count({ where: { screeningId, currentHoldId: next.id } })).toBe(2);
        return next;
      }));
      current = outcomes;
    }
    // Disconnect every workload backend before sampling from a separate observer pool.
    // Statistics flush asynchronously; observing an immediate equal count is not evidence.
    await Promise.all(workers.map((worker) => worker.close()));
    await burstDb.$disconnect();
    const deadline = Date.now() + 12_000;
    do {
      expect(await deadlocks()).toBe(before);
      await delay(250);
    } while (Date.now() < deadline);
    expect(await deadlocks()).toBe(before);
    expect(await prisma.seat.count({ where: { screeningId, currentHoldId: { in: current.map((hold) => hold.id) } } })).toBe(20);
    const events = await prisma.domainEvent.findMany({ where: { screeningId }, orderBy: { id: "asc" } });
    for (const event of events) SeatEventSchema.parse(event.payload);
    expect((await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } })).lastEventId).toBe(events.at(-1)!.id);
  }, 45_000);
});
