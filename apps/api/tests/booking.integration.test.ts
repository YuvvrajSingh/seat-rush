import { createHmac, randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSeatInvariants, claimSeatsInTransaction, createPrismaClient } from "@seatrush/db";
import { DemoSessionResponseSchema, HoldSchema, ScreeningSnapshotSchema, SeatEventSchema } from "@seatrush/shared";
import { createApp } from "../src/app.js";
import { seedDemo } from "../../../packages/db/src/seed.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || url === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
const prisma = createPrismaClient(url, { max: 20 });
const secret = "integration-test-auth-secret-at-least-32-characters";
const app = createApp({ prisma, authTokenSecret: secret, logger: pino({ level: "silent" }),
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
beforeEach(async () => { await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`; });
afterEach(async () => {
  // Each committed hold, including reclaims, must have exactly one seat-attributed creation event.
  const holds = await prisma.hold.findMany({ where: { screeningId }, include: { items: { include: { seat: true } } } });
  const events = await prisma.domainEvent.findMany({ where: { screeningId, kind: "hold.created" } });
  expect(events).toHaveLength(holds.length);
  for (const hold of holds) {
    const matching = events.filter((event) => SeatEventSchema.parse(event.payload).holdId === hold.id);
    expect(matching).toHaveLength(1);
    const event = SeatEventSchema.parse(matching[0]!.payload);
    expect(event.seats.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      hold.items.map((item) => ({ id: item.seat.id, label: item.seat.label })).sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
});
afterAll(async () => { await prisma.$disconnect(); });

function token(customer = 0, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const payload = Buffer.from(JSON.stringify({ sub: customers[customer], exp: expiresAt, role: "customer", v: 1 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function hold(customer: number, labels: string[]) {
  return request(app).post(`/screenings/${screeningId}/holds`).auth(token(customer), { type: "bearer" })
    .send({ seatIds: labels.map((label) => seats[label]) });
}
async function snapshot(customer?: number) {
  const req = request(app).get(`/screenings/${screeningId}/snapshot`);
  if (customer !== undefined) req.auth(token(customer), { type: "bearer" });
  const res = await req;
  expect(res.status).toBe(200);
  return ScreeningSnapshotSchema.parse(res.body);
}

describe("booking HTTP boundary against Postgres", () => {
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
    const conflicts = responses.filter((res) => res.status === 409);
    expect(conflicts).toHaveLength(99);
    for (const res of conflicts) expect(res.body.error).toMatchObject({ code: "seat_unavailable", seatIds: [seats.A7] });
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
    expect(mine.seats.find((s) => s.label === "B1")?.hold).toEqual({ id: first.body.id, expiresAt: first.body.expiresAt });
    expect((await snapshot(1)).seats.find((s) => s.label === "B1")?.hold).toEqual({ id: first.body.id, expiresAt: first.body.expiresAt });
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
      const res = await request(app).post(`/screenings/${screeningId}/holds`).auth(token(), { type: "bearer" }).send({ seatIds: ids });
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
    expect(events.map((e) => SeatEventSchema.parse(e.payload).seats[0]!.label)).toEqual(["A1", "A2"]);
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
    const res = await request(app).post(`/screenings/${randomUUID()}/holds`).auth(token(), { type: "bearer" }).send({ seatIds: [seats.A1] });
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
      const holdRes = await request(unavailableApp).post(`/screenings/${screeningId}/holds`).auth(token(), { type: "bearer" }).send({ seatIds: [seats.A1] });
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
    const unexpected = await request(app).post(`/screenings/${screeningId}/holds`).auth(token(1), { type: "bearer" }).send({ seatIds: [seats.A1], customerId: customers[0] });
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
