import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pino } from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSeatInvariants, claimSeatsInTransaction, cleanupExpiredHoldInTransaction, createPrismaClient, emitHoldEvent } from "@seatrush/db";
import { DemoSessionResponseSchema, HoldSchema, ScreeningSnapshotSchema, SeatEventSchema } from "@seatrush/shared";
import { createApp } from "../src/app.js";
import { seedDemo } from "../../../packages/db/src/seed.js";
import { idempotent } from "../src/idempotency.js";
import { createHoldInTransaction } from "../src/booking.js";
import { Redis } from "ioredis";
import { createConflictChannel } from "../src/conflicts.js";

import { signPaymentNotification } from "@seatrush/shared/server";
const url = process.env.TEST_DATABASE_URL;
if (!url || url === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
const prisma = createPrismaClient(url, { max: 20 });
const secret = "integration-test-auth-secret-at-least-32-characters";
const webhookSecret = "distinct-integration-webhook-secret-at-least-32-characters";
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
const conflicts = createConflictChannel({ prisma, publisher: redis, logger: pino({ level: "silent" }) });
const app = createApp({ prisma, conflicts, authTokenSecret: secret, paymentWebhookSecret: webhookSecret, logger: pino({ level: "silent" }),
  webOrigin: "http://localhost:3000", readinessChecks: { postgres: async () => {}, redis: async () => {} } });
let screeningId: string;
let customers: string[];
let seats: Record<string, string>;

beforeAll(async () => {
  // Package suites run serially; this fixture only ever touches the separate test database.
  await seedDemo(prisma);
  screeningId = (await prisma.screening.findUniqueOrThrow({ where: { demoKey: "demo-screening" } })).id;
  customers = (await prisma.identity.findMany({ where: { role: "customer" }, orderBy: { demoKey: "asc" }, take: 100 })).map((c) => c.id);
  seats = Object.fromEntries((await prisma.seat.findMany({ where: { screeningId } })).map((s) => [s.label, s.id]));
});
beforeEach(async () => {
  await conflicts.flush();
  await prisma.$executeRaw`DELETE FROM conflict_windows WHERE screening_id = ${screeningId}::uuid`;
  await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
});
afterEach(async () => {
  // Each committed hold, including reclaims, must have exactly one seat-attributed creation event.
  const holds = await prisma.hold.findMany({ where: { screeningId }, include: { items: { include: { seat: true } } } });
  const events = await prisma.domainEvent.findMany({ where: { screeningId, kind: "hold.created" } });
  expect(events).toHaveLength(holds.length);
  for (const hold of holds) {
    const matching = events.filter((event) => SeatEventSchema.parse(event.payload).holdId === hold.id);
    expect(matching).toHaveLength(1);
    const event = SeatEventSchema.parse(matching[0]!.payload);
    if (!("seats" in event)) throw new Error("Expected seat-attributed event");
    expect(event.seats.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      hold.items.map((item) => ({ id: item.seat.id, label: item.seat.label })).sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
});
afterAll(async () => { await conflicts.close(); await redis.quit(); await prisma.$disconnect(); });

function token(customer = 0, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const payload = Buffer.from(JSON.stringify({ sub: customers[customer], exp: expiresAt, role: "customer", v: 1 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function hold(customer: number, labels: string[], key = randomUUID()) {
  return request(app).post(`/screenings/${screeningId}/holds`).auth(token(customer), { type: "bearer" })
    .set("Idempotency-Key", key).send({ seatIds: labels.map((label) => seats[label]) });
}
async function snapshot(customer?: number) {
  const req = request(app).get(`/screenings/${screeningId}/snapshot`);
  if (customer !== undefined) req.auth(token(customer), { type: "bearer" });
  const res = await req;
  expect(res.status).toBe(200);
  return ScreeningSnapshotSchema.parse(res.body);
}

describe("booking HTTP boundary against Postgres", () => {
  it("keeps deadlocks flat across mixed claims, releases, conflict persistence and cleanup", async () => {
    const mixedDb = createPrismaClient(url!, { max: 20 });
    const mixedConflicts = createConflictChannel({ prisma: mixedDb, publisher: redis,
      logger: pino({ level: "silent" }), windowMs: 1, channel: `test:mixed:${randomUUID()}` });
    const mixedApp = createApp({ prisma: mixedDb, conflicts: mixedConflicts, authTokenSecret: secret,
      logger: pino({ level: "silent" }), webOrigin: "http://localhost:3000",
      readinessChecks: { postgres: async () => {}, redis: async () => {} } });
    const groups = Array.from({ length: 4 }, (_, index) => [`A${index * 2 + 1}`, `A${index * 2 + 2}`]);
    const claim = (customer: number, labels: string[]) => request(mixedApp).post(`/screenings/${screeningId}/holds`)
      .auth(token(customer), { type: "bearer" }).set("Idempotency-Key", randomUUID())
      .send({ seatIds: labels.map((label) => seats[label]).toReversed() });
    const [before] = await prisma.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    let stopFlushing = false;
    let flusher: Promise<void> | undefined;
    try {
      let current = await Promise.all(groups.map(async (group, index) => {
        const response = await claim(index, group);
        expect(response.status).toBe(201);
        return HoldSchema.parse(response.body);
      }));
      flusher = (async () => {
        while (!stopFlushing) {
          await mixedConflicts.flush();
          // Exercise real concurrent PostgreSQL/Redis flushes; fake time would stall their I/O.
          await delay(1);
        }
      })();
      for (let round = 0; round < 8; round++) {
        const rejected = await Promise.all(groups.map((group, index) => claim(40 + index, group)));
        expect(rejected.every((response) => response.status === 409 && response.body.error.code === "seat_unavailable")).toBe(true);
        const expired = current.filter((_, index) => index % 2 === 0);
        await mixedDb.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
          expires_at = expires_at - interval '5 minutes' WHERE id = ANY(${expired.map((hold) => hold.id)}::uuid[])`;
        const previousOffset = round % 2 === 0 ? 0 : 4;
        const nextOffset = round % 2 === 0 ? 4 : 0;
        const next = await Promise.all(groups.map(async (group, index) => {
          const old = current[index]!;
          const cleanup = index % 2 === 0
            ? mixedDb.$transaction(async (tx) => {
              const cleared = await cleanupExpiredHoldInTransaction(tx, old.id);
              if (cleared.length > 0) await emitHoldEvent(tx, "hold.expired", { ...old, seats: cleared }, customers[previousOffset + index]!);
            }, { maxWait: 30_000, timeout: 30_000 })
            : request(mixedApp).delete(`/holds/${old.id}`).auth(token(previousOffset + index), { type: "bearer" })
              .set("Idempotency-Key", randomUUID()).then((response) => { expect(response.status).toBe(200); });
          const [attempt] = await Promise.all([claim(nextOffset + index, group), cleanup]);
          const acquired = attempt.status === 201 ? attempt : await claim(nextOffset + index, group);
          expect(acquired.status).toBe(201);
          return HoldSchema.parse(acquired.body);
        }));
        current = next;
      }
    } finally {
      stopFlushing = true;
      await flusher;
      await mixedConflicts.close();
      // Backend stats flush on disconnect; do not mistake their delayed updates for no deadlocks.
      await mixedDb.$disconnect();
    }
    await prisma.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
    const [after] = await prisma.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    expect(after!.deadlocks).toBe(before!.deadlocks);
    expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
  }, 30_000);

  it("retries one real serialization failure and commits the original logical action once", async () => {
    let attempts = 0;
    const result = await idempotent(prisma, { customerId: customers[0]!, screeningId, operation: "hold.create",
      key: randomUUID(), payload: { seatIds: [seats.A1] }, requestId: randomUUID() }, async (tx, store) => {
      if (attempts++ === 0) await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'injected serialization failure' USING ERRCODE = '40001'; END $$`;
      const body = await createHoldInTransaction(tx, screeningId, customers[0]!, { seatIds: [seats.A1!] },
        (hold) => store({ status: 201, body: hold }));
      return { status: 201, body };
    });
    expect(result.status).toBe(201);
    expect(attempts).toBe(2);
    expect(await prisma.hold.count({ where: { screeningId } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(1);
  });

  it("locks the screening before the execution lease while reset waits", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const resetPid = Promise.withResolvers<number>();
    const keyed = idempotent(prisma, { customerId: customers[0]!, screeningId, operation: "hold.create",
      key: randomUUID(), payload: { seatIds: [seats.A1] }, requestId: randomUUID() }, async (tx, store) => {
      entered.resolve();
      await resume.promise;
      return { status: 201, body: await createHoldInTransaction(tx, screeningId, customers[0]!,
        { seatIds: [seats.A1!] }, (hold) => store({ status: 201, body: hold })) };
    });
    await entered.promise;
    const reset = prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      resetPid.resolve(backend!.pid);
      await tx.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
    }, { maxWait: 10_000, timeout: 10_000 });
    const pid = await resetPid.promise;
    try {
      await expect.poll(async () => {
        const [backend] = await prisma.$queryRaw<{ wait: string | null }[]>`
          SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${pid}`;
        return backend?.wait;
      }).toBe("Lock");
    } finally { resume.resolve(); }
    expect((await keyed).status).toBe(201);
    await reset;
    expect(await prisma.hold.count({ where: { screeningId } })).toBe(0);
    expect(await prisma.idempotencyRecord.count({ where: { screeningId } })).toBe(0);
  });

  it("races keyed HTTP creation with screening reset without database deadlocks", async () => {
    const [before] = await prisma.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    for (let round = 0; round < 10; round++) {
      const [response] = await Promise.all([
        hold(0, ["A7"]),
        prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`,
      ]);
      expect([201, 409]).toContain(response.status);
      if (response.status === 409) expect(["idempotency_in_progress", "active_hold_exists"]).toContain(response.body.error.code);
    }
    await prisma.$queryRaw`SELECT pg_sleep(1.1)::text`;
    await prisma.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
    const [after] = await prisma.$queryRaw<{ deadlocks: bigint }[]>`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
    expect(after!.deadlocks).toBe(before!.deadlocks);
  }, 30_000);

  it("hashes a seat set canonically and tells in-progress callers when to retry", async () => {
    const key = randomUUID();
    const created = await hold(0, ["A1", "A2"], key);
    expect(created.status).toBe(201);
    const replay = await hold(0, ["A2", "A1"], key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created.body);
    await prisma.$executeRaw`UPDATE idempotency_records SET status = 'in_progress', response_body = NULL,
      response_code = NULL, locked_until = now() + interval '12 seconds' WHERE key = ${key}`;
    const running = await hold(0, ["A1", "A2"], key);
    expect(running.status).toBe(409);
    expect(running.body.error.code).toBe("idempotency_in_progress");
    expect(Number(running.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(running.headers["retry-after"])).toBeLessThanOrEqual(12);
  });

  it("does not retain 5xx outcomes or partially commit a hold (FR-06)", async () => {
    const key = randomUUID();
    const input = { customerId: customers[0]!, screeningId, operation: "hold.create", key,
      payload: { seatIds: [seats.A1] }, requestId: randomUUID() };
    await expect(idempotent(prisma, input, async (tx) => {
      await createHoldInTransaction(tx, screeningId, customers[0]!, { seatIds: [seats.A1!] });
      throw new Error("Simulated crash before result commit");
    })).rejects.toThrow("Simulated crash");
    expect(await prisma.idempotencyRecord.count({ where: { key } })).toBe(0);
    expect(await prisma.hold.count({ where: { screeningId } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(0);
    expect((await hold(0, ["A1"], key)).status).toBe(201);
  });

  it("replays a hold and rejects payload reuse without another hold or event (FR-06)", async () => {
    const key = randomUUID();
    const first = await hold(0, ["A1"], key);
    const replay = await hold(0, ["A1"], key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(await prisma.hold.count({ where: { screeningId } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(1);
    const mismatch = await hold(0, ["A2"], key);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe("idempotency_key_reused");
  });

  it("executes twenty concurrent same-key requests exactly once (FR-06)", async () => {
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => hold(0, ["A7"], key)));
    const successes = responses.filter((r) => r.status === 201);
    expect(successes.length).toBeGreaterThan(0);
    for (const response of responses) {
      if (response.status === 201) expect(response.body).toEqual(successes[0]!.body);
      else {
        expect(response.body.error.code).toBe("idempotency_in_progress");
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
      }
    }
    expect(await prisma.hold.count({ where: { screeningId } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(1);
  }, 30_000);

  it("replays stored 4xx bodies and scopes keys by customer and operation", async () => {
    await hold(0, ["A1"]);
    const key = randomUUID();
    const first = await hold(1, ["A1"], key);
    const replay = await hold(1, ["A1"], key);
    expect(first.status).toBe(409);
    expect(replay.body).toEqual(first.body);
    expect((await hold(2, ["A2"], key)).status).toBe(201);
    const created = await hold(3, ["A3"], key);
    const release = () => request(app).delete(`/holds/${created.body.id}`).auth(token(3), { type: "bearer" }).set("Idempotency-Key", key);
    const released = await release();
    expect(released.status).toBe(200);
    expect((await release()).body).toEqual(released.body);
  });

  it("takes over a stale lease and requires a key on creation", async () => {
    const key = randomUUID();
    await hold(0, ["A1"], key);
    await prisma.$executeRaw`UPDATE idempotency_records SET status = 'in_progress', response_body = NULL,
      response_code = NULL, locked_until = now() - interval '1 second' WHERE key = ${key}`;
    await prisma.$executeRaw`SELECT release_hold((SELECT id FROM holds WHERE screening_id = ${screeningId}::uuid LIMIT 1), ${customers[0]}::uuid)`;
    const retry = await hold(0, ["A1"], key);
    expect(retry.status).toBe(201);
    const missing = await request(app).post(`/screenings/${screeningId}/holds`).auth(token(1), { type: "bearer" }).send({ seatIds: [seats.A2] });
    expect(missing.status).toBe(400);
  });

  it("issues a fresh web identity and a verifiable session", async () => {
    const res = await request(app).post("/auth/demo-session").send({});
    expect(res.status).toBe(200);
    const session = DemoSessionResponseSchema.parse(res.body);
    expect((await prisma.identity.findUniqueOrThrow({ where: { id: session.customer.id } })).demoKey).toMatch(/^web-/);
    expect(customers).not.toContain(session.customer.id);
    const demo = await request(app).get("/screenings/demo");
    expect(demo.body).toEqual({ screeningId });
    expect((await request(app).get(`/screenings/${screeningId}/snapshot`).auth(session.token, { type: "bearer" })).status).toBe(200);
    expect((await snapshot()).counts).toEqual({ available: 100, held: 0, confirmed: 0 });
  });

  it("allows exactly one of 100 simultaneous HTTP customers to hold A7", async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, customer) => hold(customer, ["A7"])));
    expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
    const rejected = responses.filter((res) => res.status === 409);
    expect(rejected).toHaveLength(99);
    for (const res of rejected) expect(res.body.error).toMatchObject({ code: "seat_unavailable", seatIds: [seats.A7] });
    await conflicts.flush();
    const tallies = await prisma.$queryRaw<{ seatId: string; count: number }[]>`
      SELECT seat_id AS "seatId", sum(count)::int AS count FROM conflict_windows
      WHERE screening_id = ${screeningId}::uuid GROUP BY seat_id`;
    expect(tallies).toEqual([{ seatId: seats.A7, count: 99 }]);
    const winner = HoldSchema.parse(responses.find((res) => res.status === 201)!.body);
    const events = await prisma.domainEvent.findMany({ where: { screeningId, kind: "hold.created" } });
    expect(events).toHaveLength(1);
    expect(SeatEventSchema.parse(events[0]!.payload)).toMatchObject({ kind: "hold.created", holdId: winner.id, seats: winner.seats });
    expect((await snapshot()).lastEventId).toBe(events[0]!.id.toString());
    expect(await checkSeatInvariants(prisma, screeningId)).toEqual({
      ok: true, counts: { available: 99, held: 1, confirmed: 0 }, violations: [],
    });
  }, 30_000);

  it("rejects all four requested seats when one is unavailable", async () => {
    expect((await hold(0, ["A1"])).status).toBe(201);
    const res = await hold(1, ["A1", "A2", "A3", "A4"]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "seat_unavailable", seatIds: [seats.A1] });
    const state = await snapshot(1);
    expect(state.counts).toEqual({ available: 99, held: 1, confirmed: 0 });
    expect(state.yourHold).toBeNull();
    expect(state.seats.filter((s) => ["A2", "A3", "A4"].includes(s.label)).map((s) => s.state)).toEqual(["available", "available", "available"]);
    expect(await prisma.domainEvent.count({ where: { screeningId, kind: "hold.created" } })).toBe(1);
  });

  it("rejects a customer's second active hold and does not expose ownership anonymously", async () => {
    const first = await hold(0, ["B1", "B2"]);
    expect(first.status).toBe(201);
    const second = await hold(0, ["C1"]);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("active_hold_exists");
    const mine = await snapshot(0);
    expect(mine.yourHold?.id).toBe(first.body.id);
    expect(mine.seats.filter((s) => s.heldByYou).map((s) => s.label)).toEqual(["B1", "B2"]);
    expect(mine.seats.find((s) => s.label === "B1")?.hold).toEqual({ id: first.body.id, expiresAt: first.body.expiresAt, payment: "none" });
    expect((await snapshot(1)).seats.find((s) => s.label === "B1")?.hold).toEqual({ id: first.body.id, expiresAt: first.body.expiresAt, payment: "none" });
    const anonymous = await snapshot();
    expect(anonymous.yourHold).toBeNull();
    expect(anonymous.seats.every((s) => !s.heldByYou)).toBe(true);
  });

  it("returns 404 when another customer reads or releases a hold", async () => {
    const created = await hold(0, ["A1"]);
    for (const method of ["get", "delete"] as const) {
      const res = await request(app)[method](`/holds/${created.body.id}`).auth(token(1), { type: "bearer" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
    const own = await request(app).get(`/holds/${created.body.id}`).auth(token(), { type: "bearer" });
    expect(own.status).toBe(200);
    expect(HoldSchema.parse(own.body).status).toBe("active");
    expect((await snapshot()).counts.held).toBe(1);
  });

  it("rejects missing, forged and expired bearer tokens", async () => {
    const invalidTokens = [undefined, token().slice(0, -4) + "fake", token(0, Math.floor(Date.now() / 1000) - 1)];
    for (const bearer of invalidTokens) {
      const req = request(app).post(`/screenings/${screeningId}/holds`).send({ seatIds: [seats.A1] });
      if (bearer) req.auth(bearer, { type: "bearer" });
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    }
    expect((await request(app).get(`/screenings/${screeningId}/snapshot`).auth("forged", { type: "bearer" })).status).toBe(401);
    expect((await request(app).post("/auth/demo-session").send({ customerId: customers[0] })).status).toBe(400);
  });

  it("treats expired holds as available without cleanup and allows a new owner", async () => {
    const old = await hold(0, ["A1"]);
    await prisma.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
      expires_at = expires_at - interval '5 minutes' WHERE id = ${old.body.id}::uuid`;
    const state = await snapshot(0);
    expect(state.counts).toEqual({ available: 100, held: 0, confirmed: 0 });
    expect(state.yourHold).toBeNull();
    const expired = await request(app).get(`/holds/${old.body.id}`).auth(token(), { type: "bearer" });
    expect(expired.body.status).toBe("expired");
    const release = await request(app).delete(`/holds/${old.body.id}`).auth(token(), { type: "bearer" });
    expect(release.status).toBe(409);
    expect(release.body.error.code).toBe("hold_not_active");
    expect(await prisma.domainEvent.count({ where: { screeningId, kind: "hold.released" } })).toBe(0);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.A1! } })).currentHoldId).toBe(old.body.id);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: old.body.id } })).status).toBe("active");
    expect((await hold(1, ["A1"])).status).toBe(201);
    expect((await snapshot(1)).seats.find((s) => s.label === "A1")?.heldByYou).toBe(true);
  });

  it("releases every seat and emits one matching event in the ownership transaction", async () => {
    const created = await hold(0, ["A1", "A2", "A3", "A4"]);
    expect(created.status).toBe(201);
    expect(created.body.amountPaise).toBe(80_000);
    const res = await request(app).delete(`/holds/${created.body.id}`).auth(token(), { type: "bearer" });
    expect(res.status).toBe(200);
    expect(HoldSchema.parse(res.body).status).toBe("released");
    expect((await snapshot()).counts).toEqual({ available: 100, held: 0, confirmed: 0 });
    const events = await prisma.domainEvent.findMany({ where: { screeningId }, orderBy: { id: "asc" } });
    expect(events.map((e) => e.kind)).toEqual(["hold.created", "hold.released"]);
    for (const event of events) {
      const parsed = SeatEventSchema.parse(event.payload);
      expect(parsed).toMatchObject({ id: event.id.toString(), holdId: created.body.id, seats: created.body.seats });
      expect(new Date(parsed.at).getTime()).toBe(event.createdAt.getTime());
    }
    const again = await request(app).delete(`/holds/${created.body.id}`).auth(token(), { type: "bearer" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("hold_not_active");
    expect(await prisma.domainEvent.count({ where: { screeningId, kind: "hold.released" } })).toBe(1);
    expect((await hold(1, ["A1", "A2"])).status).toBe(201);
  });

  it("returns invalid_seats for unknown, malformed, duplicate or excessive seat identifiers", async () => {
    for (const ids of [[randomUUID()], ["not-a-uuid"], [], [seats.A1, seats.A1], ["A1", "A2", "A3", "A4", "A5"].map((s) => seats[s])]) {
      const res = await request(app).post(`/screenings/${screeningId}/holds`).auth(token(), { type: "bearer" }).set("Idempotency-Key", randomUUID()).send({ seatIds: ids });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_seats");
    }
    expect((await snapshot()).counts.held).toBe(0);
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(0);
  });

  it("serializes the event cursor at commit so a snapshot cannot skip a slow committer", async () => {
    const baseline = (await snapshot()).lastEventId;
    const inserted = Promise.withResolvers<number>();
    const commit = Promise.withResolvers<void>();
    const slow = prisma.$transaction(async (tx) => {
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const claimed = await claimSeatsInTransaction(tx, { screeningId, customerId: customers[0]!, seatIds: [seats.A1!] });
      const payload = JSON.stringify({ id: "0", kind: "hold.created", screeningId, holdId: claimed.id,
        seats: claimed.seats, expiresAt: claimed.expiresAt.toISOString(), at: claimed.createdAt.toISOString() });
      await tx.$executeRaw`INSERT INTO domain_events (screening_id, customer_id, kind, payload)
        VALUES (${screeningId}::uuid, ${customers[0]}::uuid, 'hold.created', ${payload}::jsonb)`;
      inserted.resolve(connection!.pid);
      await commit.promise;
    }, { timeout: 10_000 });
    let fastResult: Promise<request.Response> | undefined;
    try {
      const slowPid = await inserted.promise;
      let completed = false;
      fastResult = hold(1, ["A2"]).then((res) => { completed = true; return res; });
      let blocked = false;
      // Synchronize on the actual database lock, not on an assumed wall-clock delay.
      for (let probes = 0; probes < 1000 && !completed && !blocked; probes++) {
        const [row] = await prisma.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${slowPid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
        blocked = row!.blocked;
      }
      expect(blocked).toBe(true);
      expect(completed).toBe(false);
      const during = await snapshot();
      expect(during.lastEventId).toBe(baseline);
      expect(during.seats.filter((s) => ["A1", "A2"].includes(s.label)).map((s) => s.state)).toEqual(["available", "available"]);
    } finally {
      commit.resolve();
      await slow;
      if (fastResult) expect((await fastResult).status).toBe(201);
    }
    const events = await prisma.domainEvent.findMany({ where: { screeningId }, orderBy: { id: "asc" } });
    expect(events.map((e) => { const event = SeatEventSchema.parse(e.payload); return "seats" in event ? event.seats[0]!.label : null; })).toEqual(["A1", "A2"]);
    expect((await snapshot()).lastEventId).toBe(events[1]!.id.toString());
  });

  it("retains a monotonic cursor after reset", async () => {
    expect((await hold(0, ["A1"])).status).toBe(201);
    const before = (await snapshot()).lastEventId;
    await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
    const after = await snapshot();
    expect(after.lastEventId).toBe(before);
    expect(after.counts.held).toBe(0);
  });

  it("never reissues a web customer and limits sessions to ten per IP per minute", async () => {
    const sessionsApp = createApp({ prisma, authTokenSecret: secret, logger: pino({ level: "silent" }),
      webOrigin: "http://localhost:3000", readinessChecks: { postgres: async () => {}, redis: async () => {} } });
    const responses = await Promise.all(Array.from({ length: 10 }, () => request(sessionsApp).post("/auth/demo-session").send({})));
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(new Set(responses.map((res) => res.body.customer.id)).size).toBe(10);
    const limited = await request(sessionsApp).post("/auth/demo-session").set("X-Forwarded-For", "spoofed-ip").send({});
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects signed tokens for missing or non-customer identities", async () => {
    const operator = await prisma.identity.findUniqueOrThrow({ where: { demoKey: "operator" } });
    for (const id of [randomUUID(), operator.id]) {
      const payload = Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, role: "customer", v: 1 })).toString("base64url");
      const signed = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
      const res = await request(app).get(`/screenings/${screeningId}/snapshot`).auth(signed, { type: "bearer" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    }
  });

  it("returns not_found for an unknown screening", async () => {
    const res = await request(app).post(`/screenings/${randomUUID()}/holds`).auth(token(), { type: "bearer" }).set("Idempotency-Key", randomUUID()).send({ seatIds: [seats.A1] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns retry_later when the request database is unreachable", async () => {
    const unavailable = createPrismaClient("postgresql://unused:unused@127.0.0.1:1/unused", { connectionTimeoutMillis: 100 });
    const unavailableApp = createApp({ prisma: unavailable, authTokenSecret: secret, logger: pino({ level: "silent" }),
      webOrigin: "http://localhost:3000", readinessChecks: { postgres: async () => {}, redis: async () => {} } });
    try {
      for (const path of ["/screenings/demo", `/screenings/${screeningId}/snapshot`]) {
        const res = await request(unavailableApp).get(path);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe("retry_later");
      }
      const holdRes = await request(unavailableApp).post(`/screenings/${screeningId}/holds`).auth(token(), { type: "bearer" }).set("Idempotency-Key", randomUUID()).send({ seatIds: [seats.A1] });
      expect(holdRes.status).toBe(503);
      expect(holdRes.body.error.code).toBe("retry_later");
    } finally { await unavailable.$disconnect(); }
  });

  it("uses canonical timestamps and numeric seat order on POST and GET", async () => {
    const created = await hold(0, ["A10", "A9"]);
    expect(created.status).toBe(201);
    const read = await request(app).get(`/holds/${created.body.id}`).auth(token(), { type: "bearer" });
    expect(read.body).toEqual(created.body);
    expect(read.body.seats.map((s: { label: string }) => s.label)).toEqual(["A9", "A10"]);
    const unexpected = await request(app).post(`/screenings/${screeningId}/holds`).auth(token(1), { type: "bearer" }).set("Idempotency-Key", randomUUID()).send({ seatIds: [seats.A1], customerId: customers[0] });
    expect(unexpected.status).toBe(400);
  });

  it("rejects noncanonical signature encodings and keeps cache policy route-scoped", async () => {
    const signed = token();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(signed.at(-1)!);
    const noncanonical = signed.slice(0, -1) + alphabet[index + 1];
    const res = await request(app).get(`/screenings/${screeningId}/snapshot`).auth(noncanonical, { type: "bearer" });
    expect(res.status).toBe(401);
    expect((await request(app).get("/openapi.json")).headers["cache-control"]).toBeUndefined();
    expect((await request(app).get("/missing")).headers["cache-control"]).toBeUndefined();
  });

  it("retries a real commit-time deadlock SQLSTATE once, then bounds repeated failure", async () => {
    for (const failures of [1, 2]) {
      await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
      await prisma.$executeRawUnsafe("CREATE SEQUENCE test_event_retry_counter");
      // Nontransactional sequence progress makes fault injection deterministic across rollbacks.
      await prisma.$executeRawUnsafe(`CREATE FUNCTION test_event_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('test_event_retry_counter') <= ${failures} THEN
            RAISE EXCEPTION 'injected commit deadlock' USING ERRCODE = '40P01';
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER test_event_retry_trigger AFTER INSERT ON domain_events
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_event_retry_failure()`);
      try {
        const res = await hold(0, ["A1"]);
        expect(res.status).toBe(failures === 1 ? 201 : 503);
        if (failures === 2) expect(res.body.error.code).toBe("retry_later");
        const [attempts] = await prisma.$queryRaw<{ attempts: number }[]>`SELECT last_value::int AS attempts FROM test_event_retry_counter`;
        expect(attempts?.attempts).toBe(2);
        expect((await snapshot()).counts.held).toBe(failures === 1 ? 1 : 0);
        expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(failures === 1 ? 1 : 0);
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER test_event_retry_trigger ON domain_events");
        await prisma.$executeRawUnsafe("DROP FUNCTION test_event_retry_failure()");
        await prisma.$executeRawUnsafe("DROP SEQUENCE test_event_retry_counter");
      }
    }
  });

  it("documents each route's known failure statuses explicitly", async () => {
    const doc = (await request(app).get("/openapi.json")).body;
    expect(Object.keys(doc.paths["/auth/demo-session"].post.responses)).toEqual(expect.arrayContaining(["400", "429", "503"]));
    expect(Object.keys(doc.paths["/screenings/{screeningId}/holds"].post.responses)).toEqual(expect.arrayContaining(["400", "401", "404", "409", "503"]));
    expect(Object.keys(doc.paths["/screenings/{screeningId}/snapshot"].get.responses)).toEqual(expect.arrayContaining(["400", "401", "404", "503"]));
  });
});

describe("Week 3 payment HTTP transactions", () => {
  const pay = (holdId: string, customer = 0, scenario = "success", key = randomUUID()) =>
    request(app).post(`/holds/${holdId}/payments`).auth(token(customer), { type: "bearer" }).set("Idempotency-Key", key).send({ scenario });
  const notify = (id: string, outcome = "succeeded", providerEventId = randomUUID()) => {
    const body = JSON.stringify({ providerEventId, paymentAttemptId: id, outcome, occurredAt: new Date().toISOString() });
    return request(app).post("/payments/notifications").set("Content-Type", "application/json")
      .set("x-seatrush-signature", signPaymentNotification(webhookSecret, body)).send(body);
  };
  const expire = (id: string) => prisma.$executeRaw`UPDATE holds SET created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' WHERE id=${id}::uuid`;
  afterEach(async () => {
    for (const event of await prisma.domainEvent.findMany({ where: { screeningId } })) SeatEventSchema.parse(event.payload);
    const report = await checkSeatInvariants(prisma, screeningId);
    expect(report.ok).toBe(true);
  });
  it("confirms once, replays initiation, rejects concurrent attempts, and protects owner reads", async () => {
    const held = await hold(0, ["C1", "C2"]); const key = randomUUID();
    const attempt = await pay(held.body.id, 0, "success", key); expect(attempt.status).toBe(201);
    expect((await pay(held.body.id, 0, "success", key)).body.id).toBe(attempt.body.id);
    expect((await pay(held.body.id)).body.error.code).toBe("payment_in_progress");
    expect((await request(app).get(`/holds/${held.body.id}`).auth(token(), { type: "bearer" })).body.latestPaymentAttemptId).toBe(attempt.body.id);
    const eventId = randomUUID();
    const burst = await Promise.all(Array.from({ length: 20 }, () => notify(attempt.body.id, "succeeded", eventId)));
    expect(burst.every((response) => response.status === 200)).toBe(true);
    expect(burst.filter((response) => response.body.disposition === "applied")).toHaveLength(1);
    expect(burst.filter((response) => response.body.disposition === "duplicate")).toHaveLength(19);
    expect(await prisma.bookedSeat.count({ where: { booking: { paymentAttemptId: attempt.body.id } } })).toBe(2);
    expect(await prisma.domainEvent.count({ where: { kind: "booking.confirmed", screeningId } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { kind: "payment.notification_ignored", screeningId } })).toBe(1);
    await Promise.all(Array.from({ length: 5 }, () => notify(attempt.body.id, "succeeded", eventId)));
    expect(await prisma.domainEvent.count({ where: { kind: "payment.notification_ignored", screeningId } })).toBe(1);
    const finalEvent = randomUUID();
    expect((await notify(attempt.body.id, "processing", finalEvent)).body.disposition).toBe("ignored");
    await Promise.all(Array.from({ length: 5 }, () => notify(attempt.body.id, "processing", finalEvent)));
    expect(await prisma.domainEvent.count({ where: { kind: "payment.notification_ignored", screeningId,
      payload: { path: ["reason"], equals: "already_final" } } })).toBe(1);
    expect((await notify(attempt.body.id, "failed", eventId)).status).toBe(409);
    const payment = await request(app).get(`/payments/${attempt.body.id}`).auth(token(), { type: "bearer" });
    const booking = await request(app).get(`/bookings/${payment.body.bookingId}`).auth(token(), { type: "bearer" });
    expect(booking.status).toBe(200); expect(booking.body.tickets).toHaveLength(2);
    expect(await prisma.booking.count({ where: { holdId: held.body.id } })).toBe(1);
    expect((await request(app).get(`/payments/${attempt.body.id}`).auth(token(1), { type: "bearer" })).status).toBe(404);
    expect((await request(app).get(`/bookings/${payment.body.bookingId}`).auth(token(1), { type: "bearer" })).status).toBe(404);
  });
  it("retries failed payment and rejects expired payment starts", async () => {
    const held = await hold(0, ["D1"]); const first = await pay(held.body.id);
    expect(first.status).toBe(201);
    expect((await notify(first.body.id, "failed")).status).toBe(200);
    const second = await pay(held.body.id); expect(second.status).toBe(201);
    expect((await notify(second.body.id)).status).toBe(200);
    const old = await hold(1, ["D2"]); await expire(old.body.id);
    expect((await pay(old.body.id, 1)).body.error.code).toBe("hold_not_active");
  });
  it("late success refunds without reclaiming reassigned seats", async () => {
    const old = await hold(0, ["E1"]); const attempt = await pay(old.body.id); await expire(old.body.id);
    const next = await hold(1, ["E1"]); expect(next.status).toBe(201);
    expect((await notify(attempt.body.id)).status).toBe(200);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.E1! } })).currentHoldId).toBe(next.body.id);
    expect(await prisma.refundRequired.count({ where: { paymentAttemptId: attempt.body.id, reason: "hold_expired" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { kind: "refund.required", screeningId } })).toBe(1);
  });
  it("authenticates decoded raw bytes and rejects invalid media types before database work", async () => {
    const held = await hold(0, ["D3"]); const attempt = await pay(held.body.id);
    const raw = JSON.stringify({ providerEventId: randomUUID(), paymentAttemptId: attempt.body.id, outcome: "succeeded", occurredAt: new Date().toISOString() });
    const signature = signPaymentNotification(webhookSecret, raw);
    const beforePayments = await prisma.paymentEvent.count();
    const beforeEvents = await prisma.domainEvent.count();
    for (const [body, signed] of [
      [JSON.stringify(JSON.parse(raw), null, 2), signature],
      [raw, signature.toUpperCase()],
      [raw, signPaymentNotification(secret, raw)],
      [raw, ""],
    ]) {
      const response = await request(app).post("/payments/notifications").set("Content-Type", "application/json")
        .set("x-seatrush-signature", signed!).send(body);
      expect(response.status).toBe(401); expect(response.body.error.code).toBe("invalid_signature");
      expect(await prisma.paymentEvent.count()).toBe(beforePayments);
      expect(await prisma.domainEvent.count()).toBe(beforeEvents);
    }
    const malformed = "not JSON";
    const invalid = await request(app).post("/payments/notifications").set("Content-Type", "application/json")
      .set("x-seatrush-signature", signPaymentNotification(webhookSecret, malformed)).send(malformed);
    expect(invalid.status).toBe(400); expect(invalid.body.error.code).toBe("invalid_json");
    for (const mediaType of ["text/plain", null]) {
      const pending = request(app).post("/payments/notifications").set("x-seatrush-signature", signature).send(raw);
      if (mediaType) pending.set("Content-Type", mediaType); else pending.unset("Content-Type");
      const response = await pending;
      expect(response.status).toBe(415); expect(response.body.error.code).toBe("unsupported_media_type");
    }
    expect(await prisma.paymentEvent.count()).toBe(beforePayments);
    expect(await prisma.domainEvent.count()).toBe(beforeEvents);
  });
  it("refunds success after release and reassignment without touching the new owner", async () => {
    const old = await hold(0, ["E2"]); const attempt = await pay(old.body.id);
    expect((await request(app).delete(`/holds/${old.body.id}`).auth(token(), { type: "bearer" })).status).toBe(200);
    const next = await hold(1, ["E2"]); expect(next.status).toBe(201);
    expect((await notify(attempt.body.id)).status).toBe(200);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.E2! } })).currentHoldId).toBe(next.body.id);
    expect(await prisma.refundRequired.count({ where: { paymentAttemptId: attempt.body.id, reason: "hold_released" } })).toBe(1);
    const payment = await request(app).get(`/payments/${attempt.body.id}`).auth(token(), { type: "bearer" });
    expect(payment.body.refund.reason).toBe("hold_released"); expect(payment.body.bookingId).toBeNull();
  });
  it("rechecks seat pointers after customer-lock waits for notifications and payment starts", async () => {
    for (const mode of ["notification", "start"] as const) {
      const customer = mode === "notification" ? 0 : 2;
      const label = mode === "notification" ? "E3" : "E4";
      const old = await hold(customer, [label]);
      const attempt = mode === "notification" ? await pay(old.body.id, customer) : null;
      const locked = Promise.withResolvers<void>(); const unlock = Promise.withResolvers<void>();
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM identities WHERE id=${customers[customer]}::uuid FOR NO KEY UPDATE`;
        locked.resolve(); await unlock.promise;
      }, { timeout: 10000 });
      await locked.promise;
      let pending: Promise<request.Response> | undefined;
      try {
        await prisma.$executeRaw`UPDATE holds SET created_at=now()-interval '5 minutes'+interval '400 milliseconds',
          expires_at=now()+interval '400 milliseconds' WHERE id=${old.body.id}::uuid`;
        pending = (mode === "notification" ? notify(attempt!.body.id) : pay(old.body.id, customer)).then((response) => response);
        let waiting = false;
        for (let poll = 0; poll < 100; poll++) {
          const [state] = await prisma.$queryRaw<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM identities%') AS waiting`;
          if (state?.waiting) { waiting = true; break; }
          await delay(5);
        }
        expect(waiting).toBe(true);
        await delay(450);
        const next = await hold(customer + 1, [label]); expect(next.status).toBe(201);
        unlock.resolve(); await blocker;
        const response = await pending;
        expect(response.status).toBe(mode === "notification" ? 200 : 409);
        if (mode === "notification") {
          expect(response.body.disposition).toBe("applied");
          expect(await prisma.refundRequired.count({ where: { paymentAttemptId: attempt!.body.id, reason: "hold_expired" } })).toBe(1);
          expect(await prisma.booking.count({ where: { paymentAttemptId: attempt!.body.id } })).toBe(0);
        } else {
          expect(response.body.error.code).toBe("hold_not_active");
          expect(await prisma.paymentAttempt.count({ where: { holdId: old.body.id } })).toBe(0);
        }
        expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats[label]! } })).currentHoldId).toBe(next.body.id);
      } finally { unlock.resolve(); await blocker; await pending; }
    }
  });
  it("serializes expiry-edge success versus parallel claims for 32 iterations", async () => {
    let bookedOutcomes = 0; let refundedOutcomes = 0;
    for (let iteration = 0; iteration < 32; iteration++) {
      const label = `${"FGHI"[Math.floor(iteration / 8)]}${iteration % 8 + 1}`;
      const old = await hold(0, [label]); expect(old.status).toBe(201);
      const attempt = await pay(old.body.id); expect(attempt.status).toBe(201);
      const edgeMs = iteration % 2 === 0 ? 0 : 100 + iteration;
      await prisma.$executeRaw`UPDATE holds SET created_at=now()-interval '5 minutes'+${edgeMs}*interval '1 millisecond',
        expires_at=now()+${edgeMs}*interval '1 millisecond' WHERE id=${old.body.id}::uuid`;
      const [notification, claim] = await Promise.all([notify(attempt.body.id), hold(1, [label])]);
      expect(notification.status).toBe(200); expect([201, 409]).toContain(claim.status);
      const bookings = await prisma.booking.count({ where: { paymentAttemptId: attempt.body.id } });
      const refunds = await prisma.refundRequired.count({ where: { paymentAttemptId: attempt.body.id } });
      bookedOutcomes += bookings; refundedOutcomes += refunds;
      expect(bookings + refunds).toBe(1);
      if (bookings === 1) expect(claim.status).toBe(409);
      if (claim.status === 201) {
        expect(refunds).toBe(1);
        expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats[label]! } })).currentHoldId).toBe(claim.body.id);
        expect((await request(app).delete(`/holds/${claim.body.id}`).auth(token(1), { type: "bearer" })).status).toBe(200);
      }
      expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
      if (refunds === 1) await prisma.$executeRaw`UPDATE holds SET status='expired' WHERE id=${old.body.id}::uuid`;
    }
    expect(bookedOutcomes).toBeGreaterThan(0);
    expect(refundedOutcomes).toBeGreaterThan(0);
  });
});
