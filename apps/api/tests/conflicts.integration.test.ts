import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "@seatrush/db";
import { ConflictWindowSchema, type ConflictWindow } from "@seatrush/shared";
import { createConflictChannel, type ConflictChannel } from "../src/conflicts.js";
const { TEST_DATABASE_URL, DATABASE_URL, REDIS_URL } = process.env;
if (!TEST_DATABASE_URL || TEST_DATABASE_URL === DATABASE_URL || !REDIS_URL) {
  throw new Error("A separate TEST_DATABASE_URL and REDIS_URL are required");
}
const prisma = createPrismaClient(TEST_DATABASE_URL);
const publisher = new Redis(REDIS_URL, { lazyConnect: true });
const subscriber = new Redis(REDIS_URL, { lazyConnect: true });
const logger = pino({ level: "silent" });
const pubsubChannel = `seatrush:test:conflicts:${randomUUID()}`;
const messages: ConflictWindow[] = [];
const channels: ConflictChannel[] = [];
let screenings: { id: string; seatIds: string[] }[];

beforeAll(async () => {
  subscriber.on("message", (channel, payload) => {
    if (channel === pubsubChannel) messages.push(ConflictWindowSchema.parse(JSON.parse(payload)));
  });
  await Promise.all([publisher.connect(), subscriber.connect()]);
  await subscriber.subscribe(pubsubChannel);
});
beforeEach(async () => {
  messages.length = 0;
  screenings = await Promise.all(["Conflict fixture A", "Conflict fixture B"].map(async (title) => {
    const screening = await prisma.screening.create({
      data: {
        title, startsAt: new Date("2026-12-01T18:00:00.000Z"), durationMinutes: 180, seatPricePaise: 25_000,
        seats: { create: [7, 8, 9].map((number) => ({ label: `A${number}`, row: "A", number })) },
      },
      include: { seats: { orderBy: { number: "asc" } } },
    });
    return { id: screening.id, seatIds: screening.seats.map((seat) => seat.id) };
  }));
});
afterEach(async () => {
  try {
    await Promise.all(channels.splice(0).map((channel) => channel.close()));
  } finally {
    const ids = screenings.map((screening) => screening.id);
    await prisma.$executeRaw`DELETE FROM conflict_windows WHERE screening_id = ANY(${ids}::uuid[])`;
    await prisma.seat.deleteMany({ where: { screeningId: { in: ids } } });
    await prisma.screening.deleteMany({ where: { id: { in: ids } } });
  }
});
afterAll(async () => {
  publisher.disconnect();
  subscriber.disconnect();
  await prisma.$disconnect();
});

function channel(windowMs?: number) {
  const result = createConflictChannel({ prisma, publisher, logger, channel: pubsubChannel, ...(windowMs === undefined ? {} : { windowMs }) });
  channels.push(result);
  return result;
}
function received() {
  const ids = new Set(screenings.map((screening) => screening.id));
  return messages.filter((message) => ids.has(message.screeningId));
}
async function persisted() {
  const ids = screenings.map((screening) => screening.id);
  const rows = await prisma.$queryRaw<{ window: unknown }[]>`
    SELECT jsonb_build_object('id', id, 'kind', 'seat.conflict', 'screeningId', screening_id,
      'seatId', seat_id, 'count', count, 'windowStartedAt', window_started_at,
      'windowEndedAt', window_ended_at, 'at', created_at) AS window
    FROM conflict_windows WHERE screening_id = ANY(${ids}::uuid[]) ORDER BY screening_id, seat_id, id`;
  return rows.map((row) => ConflictWindowSchema.parse(row.window));
}

describe("durable conflict channel against real Postgres and Redis", () => {
  it("counts 100 request-equivalent rejections exactly, attributing only supplied conflicting seats", async () => {
    const conflicts = channel(10_000);
    const first = screenings[0]!;
    const second = screenings[1]!;
    for (let request = 0; request < 100; request++) {
      // A9 may have been requested, but SQL reported only A7 (and sometimes A8) as conflicting.
      const ids = request < 25 ? [first.seatIds[0]!, first.seatIds[1]!] : [first.seatIds[0]!];
      expect(conflicts.record(first.id, ids)).toBeUndefined();
    }
    for (let request = 0; request < 7; request++) conflicts.record(second.id, [second.seatIds[0]!]);
    conflicts.record(first.id, []);
    // Recording is synchronous and does not persist or publish before the window is flushed.
    expect(await persisted()).toHaveLength(0);
    expect(received()).toHaveLength(0);
    await conflicts.flush();
    await expect.poll(() => received().length).toBe(3);
    const windows = await persisted();
    expect(windows.map(({ screeningId, seatId, count }) => ({ screeningId, seatId, count }))).toEqual(
      expect.arrayContaining([
        { screeningId: first.id, seatId: first.seatIds[0], count: 100 },
        { screeningId: first.id, seatId: first.seatIds[1], count: 25 },
        { screeningId: second.id, seatId: second.seatIds[0], count: 7 },
      ]),
    );
    expect(windows).toHaveLength(3);
    expect(received().map((window) => window.id).sort()).toEqual(windows.map((window) => window.id).sort());
    for (const window of received()) {
      for (const timestamp of [window.windowStartedAt, window.windowEndedAt, window.at]) {
        expect(timestamp).toBe(new Date(timestamp).toISOString());
      }
    }
    for (const window of windows) {
      expect(new Date(window.windowEndedAt).getTime()).toBeGreaterThanOrEqual(new Date(window.windowStartedAt).getTime());
      expect(new Date(window.windowEndedAt).getTime() - new Date(window.windowStartedAt).getTime()).toBeLessThanOrEqual(10_000);
    }
    expect(await prisma.domainEvent.count({ where: { screeningId: { in: screenings.map((screening) => screening.id) } } })).toBe(0);
    expect(await prisma.hold.count({ where: { screeningId: first.id } })).toBe(0);
  });

  it("automatically publishes exact per-seat counts in the default 100 ms window", async () => {
    const conflicts = channel();
    const screening = screenings[0]!;
    for (let request = 0; request < 100; request++) {
      // Duplicate ids cannot turn one rejected request into two conflicts for the same seat.
      conflicts.record(screening.id, [screening.seatIds[0]!, screening.seatIds[0]!]);
    }
    await expect.poll(() => received().reduce((total, window) => total + window.count, 0), { timeout: 2_000 }).toBe(100);
    const windows = await persisted();
    expect(windows.reduce((total, window) => total + window.count, 0)).toBe(100);
    for (const window of windows) {
      expect(window.seatId).toBe(screening.seatIds[0]);
      expect(new Date(window.windowEndedAt).getTime() - new Date(window.windowStartedAt).getTime()).toBe(100);
    }
  });

  it("flushes partial windows on shutdown, including records arriving during an earlier flush", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: publishing, resolve: announce } = Promise.withResolvers<void>();
    const conflicts = createConflictChannel({
      prisma, logger, channel: pubsubChannel, windowMs: 10_000,
      publisher: { publish: async (name, payload) => { announce(); await gate; return publisher.publish(name, payload); } },
    });
    channels.push(conflicts);
    const screening = screenings[0]!;
    try {
      conflicts.record(screening.id, [screening.seatIds[0]!]);
      const firstFlush = conflicts.flush();
      await publishing;
      conflicts.record(screening.id, [screening.seatIds[1]!]);
      const closing = conflicts.close();
      expect(() => conflicts.record(screening.id, [screening.seatIds[0]!])).toThrow(/closed/i);
      release();
      await Promise.all([firstFlush, closing, conflicts.close()]);
      await conflicts.flush();
      await expect.poll(() => received().length).toBe(2);
      expect((await persisted()).map((window) => window.count)).toEqual([1, 1]);
      expect(new Set(received().map((window) => window.id)).size).toBe(2);
    } finally {
      release();
    }
  });

  it("drops failed live publications rather than replaying stale windows after Redis recovers", async () => {
    const redis = new Redis(REDIS_URL!, {
      lazyConnect: true, commandTimeout: 1_000, maxRetriesPerRequest: 1,
      enableOfflineQueue: false, retryStrategy: () => null,
    });
    redis.on("error", () => {});
    redis.disconnect();
    const conflicts = createConflictChannel({ prisma, publisher: redis, logger, channel: pubsubChannel, windowMs: 10_000 });
    channels.push(conflicts);
    try {
      const screening = screenings[0]!;
      conflicts.record(screening.id, [screening.seatIds[0]!]);
      await conflicts.flush();
      const windows = await persisted();
      expect(windows).toHaveLength(1);
      expect(windows[0]!.count).toBe(1);
      expect(received()).toHaveLength(0);
      await redis.connect();
      await conflicts.flush();
      conflicts.record(screening.id, [screening.seatIds[1]!]);
      await conflicts.flush();
      await expect.poll(() => received().length).toBe(1);
      expect(received()[0]!.seatId).toBe(screening.seatIds[1]);
      expect(received()[0]!.id).not.toBe(windows[0]!.id);
      expect(await persisted()).toHaveLength(2);
    } finally {
      await conflicts.close();
      redis.disconnect();
    }
  });

  it("persists every pending batch and closes promptly when real Redis is unreachable", async () => {
    const redis = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true, commandTimeout: 1_000, maxRetriesPerRequest: 1,
      enableOfflineQueue: false, connectTimeout: 100, retryStrategy: () => null,
    });
    redis.on("error", () => {});
    const conflicts = createConflictChannel({
      prisma, publisher: redis, logger, channel: pubsubChannel, windowMs: 1,
    });
    channels.push(conflicts);
    try {
      await expect(redis.connect()).rejects.toThrow();
      const screening = screenings[0]!;
      for (let batch = 0; batch < 4; batch++) {
        for (let request = 0; request < 25; request++) {
          conflicts.record(screening.id, [screening.seatIds[0]!]);
        }
        // Keep timer callbacks out of this turn: record seals several pending windows
        // before shutdown gets its first chance to persist or publish any batch.
        const nextWindow = Date.now() + 2;
        while (Date.now() < nextWindow) { /* advance the real window clock */ }
      }
      const startedAt = performance.now();
      await conflicts.close();
      expect(performance.now() - startedAt).toBeLessThan(1_500);
      const windows = await persisted();
      expect(windows.length).toBeGreaterThanOrEqual(4);
      expect(windows.reduce((total, window) => total + window.count, 0)).toBe(100);
      expect(received()).toHaveLength(0);
      await conflicts.flush();
      expect((await persisted()).reduce((total, window) => total + window.count, 0)).toBe(100);
    } finally {
      redis.disconnect();
    }
  });

  it("keeps the public conflict-window contract strict and separate from ownership events", () => {
    const screening = screenings[0]!;
    const valid = {
      id: screening.id, kind: "seat.conflict", screeningId: screening.id, seatId: screening.seatIds[0], count: 1,
      windowStartedAt: "2026-11-08T12:00:00.000Z", windowEndedAt: "2026-11-08T12:00:00.100Z", at: "2026-11-08T12:00:00.101Z",
    };
    expect(ConflictWindowSchema.safeParse(valid).success).toBe(true);
    expect(ConflictWindowSchema.safeParse({ ...valid, customerId: screening.id }).success).toBe(false);
    expect(ConflictWindowSchema.safeParse({ ...valid, count: 0 }).success).toBe(false);
    expect(ConflictWindowSchema.safeParse({ ...valid, windowEndedAt: "2026-11-08T11:59:59.000Z" }).success).toBe(false);
  });
});
