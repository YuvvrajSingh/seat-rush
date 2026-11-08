import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SEAT_PRICE_PAISE, TOTAL_SEATS } from "@seatrush/shared";
import { createPrismaClient } from "../src/client.js";
import { checkSeatInvariants } from "../src/invariants.js";
import {
  claimSeats, claimSeatsInTransaction, cleanupExpiredHold, cleanupExpiredHoldInTransaction,
  releaseHold, releaseHoldInTransaction, type SeatClaim,
} from "../src/seat-claims.js";
import { classifyDbError } from "../src/errors.js";
import { takeOverStaleIdempotency } from "../src/idempotency.js";
import { seedDemo } from "../src/seed.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || databaseUrl === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
const prisma = createPrismaClient(databaseUrl, { max: 60 });
let screeningId: string;
let customers: string[];
let seats: Record<string, string>;

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE domain_events, refund_required, payment_events, booked_seats,
    bookings, payment_attempts, hold_items, seats, holds, idempotency_records, simulation_runs,
    screenings, identities RESTART IDENTITY CASCADE`);
  await seedDemo(prisma);
  screeningId = (await prisma.screening.findUniqueOrThrow({ where: { demoKey: "demo-screening" } })).id;
  customers = (await prisma.identity.findMany({ where: { role: "customer" }, orderBy: { demoKey: "asc" }, take: 60 })).map((c) => c.id);
  seats = Object.fromEntries((await prisma.seat.findMany({ where: { screeningId } })).map((s) => [s.label, s.id]));
});
afterAll(async () => { await prisma.$disconnect(); });

function claim(customer: number, labels: string[]) {
  return claimSeats(prisma, { screeningId, customerId: customers[customer]!, seatIds: labels.map((label) => seats[label]!) });
}

async function expire(holdId: string) {
  await prisma.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
    expires_at = expires_at - interval '5 minutes' WHERE id = ${holdId}::uuid`;
}

async function confirm(hold: SeatClaim) {
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
    await tx.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    return tx.booking.create({ data: {
      holdId: hold.id, screeningId, customerId: hold.customerId,
      paymentAttemptId: attempt.id, amountPaise: hold.amountPaise,
    } });
  });
}

describe("Postgres seat ownership", () => {
  it("allows exactly one of 50 parallel transactions to claim A7", async () => {
    const pids = new Set<number>();
    const { promise: barrier, resolve: ready } = Promise.withResolvers<void>();
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, customer) => prisma.$transaction(async (tx) => {
      const [connection] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      pids.add(connection!.pid);
      if (pids.size === 50) ready();
      await barrier;
      return claimSeatsInTransaction(tx, { screeningId, customerId: customers[customer]!, seatIds: [seats.A7!] });
    }, { maxWait: 30_000, timeout: 30_000 })));
    expect(pids.size).toBe(50);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(49);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(Error);
      if (result.status === "rejected") expect(result.reason.message).toMatch(/seat conflict/);
    }
    expect(await prisma.hold.count()).toBe(1);
    expect(await checkSeatInvariants(prisma, screeningId)).toEqual({
      ok: true, counts: { available: 99, held: 1, confirmed: 0 }, violations: [],
    });
  });

  it("rejects a conflicting four-seat request without claiming any of its other seats", async () => {
    await claim(0, ["A1"]);
    await expect(claim(1, ["A1", "A2", "A3", "A4"])).rejects.toThrow(/seat conflict/);
    expect(await prisma.hold.count()).toBe(1);
    expect(await prisma.seat.count({ where: { label: { in: ["A2", "A3", "A4"] }, currentHoldId: { not: null } } })).toBe(0);
  });

  it("validates distinct quantities in the database and uses database-generated five-minute expiry", async () => {
    for (const labels of [[], ["A1", "A1"], ["A1", "A2", "A3", "A4", "A5"]]) {
      await expect(claim(0, labels)).rejects.toThrow(/1-4 distinct seats/);
    }
    const hold = await claim(0, ["A1", "A2", "A3", "A4"]);
    expect(hold.expiresAt.getTime() - hold.createdAt.getTime()).toBe(300_000);
    expect(hold.amountPaise).toBe(4 * SEAT_PRICE_PAISE);
  });

  it("reclaims an expired hold without cleanup, including for the same customer", async () => {
    const old = await claim(0, ["A1"]);
    await expire(old.id);
    const current = await claim(0, ["A1"]);
    expect(current.id).not.toBe(old.id);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("active");
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.A1! } })).currentHoldId).toBe(current.id);
    expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
  });

  it("leaves a newer owner untouched when an old expiry job arrives late", async () => {
    const old = await claim(0, ["A1"]);
    await expire(old.id);
    const current = await claim(1, ["A1"]);
    expect(await cleanupExpiredHold(prisma, old.id)).toBe(0);
    expect(await cleanupExpiredHold(prisma, old.id)).toBe(0);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.A1! } })).currentHoldId).toBe(current.id);
  });

  it("returns only cleared expiry seats in row and numeric seat order", async () => {
    const old = await claim(0, ["B1", "A10", "A2", "A1"]);
    expect(await prisma.$transaction((tx) => cleanupExpiredHoldInTransaction(tx, old.id))).toEqual([]);
    await expire(old.id);
    const current = await claim(1, ["A1"]);
    expect(await prisma.$transaction((tx) => cleanupExpiredHoldInTransaction(tx, old.id))).toEqual([
      { id: seats.A2, label: "A2" },
      { id: seats.A10, label: "A10" },
      { id: seats.B1, label: "B1" },
    ]);
    expect(await prisma.$transaction((tx) => cleanupExpiredHoldInTransaction(tx, old.id))).toEqual([]);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.A1! } })).currentHoldId).toBe(current.id);
    expect((await prisma.hold.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("expired");
  });

  it("rejects a second active customer/screening hold at the exclusion constraint", async () => {
    await claim(0, ["A1"]);
    await expect(claim(0, ["B1"])).rejects.toThrow(/customer already has an active hold/);
    await expect(prisma.hold.create({ data: {
      screeningId, customerId: customers[0]!, seatCount: 1, amountPaise: SEAT_PRICE_PAISE,
    } })).rejects.toThrow(/holds_one_active_customer/);
    expect(await prisma.hold.count()).toBe(1);
  });

  it("rejects incomplete direct SQL holds and direct theft of a live seat", async () => {
    await expect(prisma.hold.create({ data: {
      screeningId, customerId: customers[0]!, seatCount: 1, amountPaise: SEAT_PRICE_PAISE,
    } })).rejects.toThrow(/hold items or amount mismatch/);
    const first = await claim(0, ["A1"]);
    const second = await claim(1, ["A2"]);
    await expect(prisma.$executeRaw`UPDATE seats SET current_hold_id = ${second.id}::uuid WHERE id = ${seats.A1!}::uuid`)
      .rejects.toThrow(/seat ownership conflict/);
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seats.A1! } })).currentHoldId).toBe(first.id);
  });

  it("enforces one unresolved payment attempt and absorbing terminal states", async () => {
    const hold = await claim(0, ["A1"]);
    const data = { holdId: hold.id, amountPaise: hold.amountPaise };
    await expect(prisma.$executeRaw`INSERT INTO payment_attempts (hold_id, amount_paise, status, finalized_at)
      VALUES (${hold.id}::uuid, ${hold.amountPaise}, 'succeeded', now())`)
      .rejects.toThrow(/payment must start initiated/);
    await expect(prisma.paymentAttempt.create({ data: { ...data, amountPaise: 1 } }))
      .rejects.toThrow(/payment must start initiated/);
    const attempt = await prisma.paymentAttempt.create({ data });
    await expect(prisma.paymentAttempt.create({ data })).rejects.toMatchObject({ code: "P2002" });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'failed', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    await expect(prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded' WHERE id = ${attempt.id}::uuid`)
      .rejects.toThrow(/final payment attempt is immutable/);
    await expect(prisma.paymentAttempt.create({ data })).resolves.toMatchObject({ status: "initiated" });
  });

  it("confirms seats and durable events atomically and rejects double confirmation at the unique index", async () => {
    const hold = await claim(0, ["A1"]);
    const booking = await confirm(hold);
    const ticket = await prisma.bookedSeat.findFirstOrThrow();
    expect(await prisma.domainEvent.count({ where: { bookingId: booking.id, kind: "booking.confirmed" } })).toBe(1);
    expect(ticket.ticketCode).toBeTruthy();
    await expect(prisma.bookedSeat.create({ data: {
      bookingId: booking.id, screeningId, seatId: seats.A1!, pricePaise: SEAT_PRICE_PAISE,
    } })).rejects.toMatchObject({ code: "P2002" });
    await expect(claim(1, ["A1"])).rejects.toThrow(/seat conflict/);
    expect(await prisma.bookedSeat.count()).toBe(1);
  });

  it("rolls back booking, ticket and outbox together and refuses confirmation after expiry", async () => {
    const hold = await claim(0, ["A1"]);
    const attempt = await prisma.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    await expect(prisma.$transaction(async (tx) => {
      await tx.booking.create({ data: { holdId: hold.id, screeningId, customerId: hold.customerId,
        paymentAttemptId: attempt.id, amountPaise: hold.amountPaise } });
      throw new Error("abort enclosing transaction");
    })).rejects.toThrow(/abort enclosing transaction/);
    expect(await prisma.booking.count()).toBe(0);
    expect(await prisma.bookedSeat.count()).toBe(0);
    expect(await prisma.domainEvent.count()).toBe(0);
    await expire(hold.id);
    await expect(prisma.booking.create({ data: { holdId: hold.id, screeningId, customerId: hold.customerId,
      paymentAttemptId: attempt.id, amountPaise: hold.amountPaise } })).rejects.toThrow(/valid hold/);
  });

  it("scopes durable idempotency keys and rejects storing 5xx responses", async () => {
    const data = { screeningId, customerId: customers[0]!, operation: "hold.create", key: "retry", requestHash: "sha256:abc" };
    await prisma.idempotencyRecord.create({ data });
    await expect(prisma.idempotencyRecord.create({ data })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.idempotencyRecord.create({ data: { ...data, customerId: customers[1]! } })).resolves.toBeTruthy();
    await expect(prisma.idempotencyRecord.create({ data: { ...data, operation: "payment.initiate" } })).resolves.toBeTruthy();
    await expect(prisma.idempotencyRecord.update({
      where: { customerId_operation_key: { customerId: customers[0]!, operation: data.operation, key: data.key } },
      data: { status: "completed", responseCode: 503, responseBody: { error: "unavailable" } },
    })).rejects.toThrow(/idempotency_records_values_check/);
  });

  it("reports a clean mixed partition and detects injected inventory damage", async () => {
    const live = await claim(0, ["A1", "A2", "A3", "A4"]);
    await confirm(await claim(1, ["B1"]));
    expect(await checkSeatInvariants(prisma, screeningId)).toEqual({
      ok: true, counts: { available: 95, held: 4, confirmed: 1 }, violations: [],
    });
    await expect(prisma.$executeRaw`UPDATE seats SET current_hold_id = ${live.id}::uuid WHERE id = ${seats.B1!}::uuid`)
      .rejects.toThrow(/seat ownership conflict/);
    // Deliberately bypass user triggers as the test database owner to exercise corruption reporting.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE seats DISABLE TRIGGER USER");
      await tx.$executeRaw`UPDATE seats SET current_hold_id = ${live.id}::uuid WHERE id = ${seats.B1!}::uuid`;
      await tx.$executeRawUnsafe("ALTER TABLE seats ENABLE TRIGGER USER");
    });
    const overlap = await checkSeatInvariants(prisma, screeningId);
    expect(overlap.ok).toBe(false);
    expect(overlap.violations).toContain("1 confirmed seats also actively held");
    await prisma.$executeRaw`UPDATE seats SET current_hold_id = NULL WHERE id = ${seats.B1!}::uuid`;
    await prisma.seat.delete({ where: { id: seats.J10! } });
    const damaged = await checkSeatInvariants(prisma, screeningId);
    expect(damaged.ok).toBe(false);
    expect(damaged.violations).toContain("Expected 100 seats, found 99");
  });

  it("seeds idempotently with 100 seats, 1050 customers, one operator and a future three-hour screening", async () => {
    await seedDemo(prisma);
    expect(await prisma.screening.count()).toBe(1);
    expect(await prisma.seat.count()).toBe(TOTAL_SEATS);
    expect(await prisma.identity.count({ where: { role: "customer" } })).toBe(1_050);
    expect(await prisma.identity.count({ where: { role: "operator" } })).toBe(1);
    const [row] = await prisma.$queryRaw<{ future: boolean; duration: number }[]>`
      SELECT starts_at > now() AS future, duration_minutes AS duration FROM screenings WHERE id = ${screeningId}::uuid`;
    expect(row).toEqual({ future: true, duration: 180 });
  });
});

describe("ownership regression coverage", () => {
  it("cleans up versus reverse-order reclaim 1000 times without deadlocks or owner clobbering", async () => {
    const labels = Object.keys(seats).sort();
    const groups = Array.from({ length: 25 }, (_, i) => labels.slice(i * 4, i * 4 + 4));
    let current = await Promise.all(groups.map((group, i) => claim(i, group)));
    for (let round = 0; round < 40; round++) {
      await prisma.$executeRaw`UPDATE holds SET created_at = created_at - interval '5 minutes',
        expires_at = expires_at - interval '5 minutes' WHERE id = ANY(${current.map((h) => h.id)}::uuid[])`;
      const replacementOffset = round % 2 === 0 ? 25 : 0;
      const outcomes = await Promise.all(groups.map(async (group, i) => {
        const [cleared, next] = await Promise.all([
          cleanupExpiredHold(prisma, current[i]!.id),
          claim(replacementOffset + i, group.toReversed()),
        ]);
        expect(cleared).toBeGreaterThanOrEqual(0);
        const owned = await prisma.seat.count({ where: { currentHoldId: next.id } });
        expect(owned).toBe(4);
        return next;
      }));
      current = outcomes;
    }
    expect(await checkSeatInvariants(prisma, screeningId)).toEqual({
      ok: true, counts: { available: 0, held: 100, confirmed: 0 }, violations: [],
    });
  });

  it("orders mixed-order multi-seat claims and reports only expected conflicts", async () => {
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, customer) => claim(
      customer, customer % 2 === 0 ? ["A1", "A2", "A3", "A4"] : ["A4", "A3", "A2", "A1"],
    )));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(classifyDbError(result.reason)).toBe("seat_conflict");
    }
    expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
  });

  it("distinguishes unknown and foreign seat identifiers from seat conflicts", async () => {
    await expect(claimSeats(prisma, {
      screeningId, customerId: customers[0]!, seatIds: ["00000000-0000-0000-0000-000000000001"],
    })).rejects.toThrow(/unknown or foreign screening seat/);
    const other = await prisma.screening.create({ data: {
      title: "Other", startsAt: new Date("2099-01-01"), durationMinutes: 180, seatPricePaise: SEAT_PRICE_PAISE,
    } });
    const foreign = await prisma.seat.create({ data: { screeningId: other.id, label: "A1", row: "A", number: 1 } });
    try {
      await claimSeats(prisma, { screeningId, customerId: customers[0]!, seatIds: [foreign.id] });
      expect.fail("foreign seat must not be claimed");
    } catch (error) { expect(classifyDbError(error)).toBe("invalid_input"); }
    const hold = await claim(0, ["A1"]);
    expect(hold.seats).toEqual([{ id: seats.A1, label: "A1" }]);
    try { await claim(0, ["A1"]); expect.fail("second hold must fail"); }
    catch (error) { expect(classifyDbError(error)).toBe("active_hold_exists"); }
  });

  it("releases a customer and composes cleanup/release with durable event writes", async () => {
    const hold = await claim(0, ["A1"]);
    const cleared = await prisma.$transaction(async (tx) => {
      const count = await releaseHoldInTransaction(tx, hold.id, hold.customerId);
      await tx.domainEvent.create({ data: { screeningId, kind: "hold.released", payload: { holdId: hold.id } } });
      return count;
    });
    expect(cleared).toBe(1);
    const next = await claim(0, ["A1"]);
    await expire(next.id);
    await prisma.$transaction(async (tx) => {
      expect(await cleanupExpiredHoldInTransaction(tx, next.id)).toEqual([{ id: seats.A1, label: "A1" }]);
      await tx.domainEvent.create({ data: { screeningId, kind: "hold.expired", payload: { holdId: next.id } } });
    });
    expect(await prisma.domainEvent.count()).toBe(2);
    expect(await releaseHold(prisma, hold.id, hold.customerId)).toBe(0);
    expect((await checkSeatInvariants(prisma, screeningId)).counts.available).toBe(100);
  });

  it("forces insert timestamps and rejects extending/moving/changing a hold", async () => {
    const hold = await prisma.$transaction(async (tx) => {
      const h = await tx.hold.create({ data: {
        screeningId, customerId: customers[0]!, seatCount: 1, amountPaise: SEAT_PRICE_PAISE,
        createdAt: new Date("2099-01-01"), expiresAt: new Date("2099-01-01T00:05:00Z"),
      } });
      await tx.holdItem.create({ data: { holdId: h.id, seatId: seats.A1!, screeningId, pricePaise: SEAT_PRICE_PAISE } });
      await tx.seat.update({ where: { id: seats.A1! }, data: { currentHoldId: h.id } });
      return h;
    });
    expect(hold.createdAt.getUTCFullYear()).not.toBe(2099);
    expect(hold.expiresAt.getTime() - hold.createdAt.getTime()).toBe(300_000);
    await expect(prisma.$executeRaw`UPDATE holds SET created_at = created_at + interval '1 second',
      expires_at = expires_at + interval '1 second' WHERE id = ${hold.id}::uuid`)
      .rejects.toThrow(/cannot be extended or changed/);
    await expect(prisma.hold.update({ where: { id: hold.id }, data: { customerId: customers[1]! } }))
      .rejects.toThrow(/cannot be extended or changed/);
    await expect(prisma.hold.update({ where: { id: hold.id }, data: { amountPaise: 1 } }))
      .rejects.toThrow(/cannot be extended or changed/);
  });

  it("allows an older transaction to release a newer hold without a volatile CHECK failure", async () => {
    const started = Promise.withResolvers<void>();
    const inserted = Promise.withResolvers<SeatClaim>();
    const release = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT now()`;
      started.resolve();
      const hold = await inserted.promise;
      return releaseHoldInTransaction(tx, hold.id, hold.customerId);
    });
    await started.promise;
    inserted.resolve(await claim(0, ["A1"]));
    expect(await release).toBe(1);
  });

  it("allows only one confirmation-versus-expiry outcome", async () => {
    for (let round = 0; round < 20; round++) {
      const hold = await claim(0, ["A1"]);
      const attempt = await prisma.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
      await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
      await prisma.$executeRaw`UPDATE holds SET
        created_at = now() - interval '5 minutes' + interval '20 milliseconds',
        expires_at = now() + interval '20 milliseconds' WHERE id = ${hold.id}::uuid`;
      const confirmation = (async () => {
        if (round % 2 === 1) await prisma.$queryRaw`SELECT pg_sleep(0.025)::text`;
        return prisma.booking.create({ data: {
          holdId: hold.id, screeningId, customerId: hold.customerId, paymentAttemptId: attempt.id, amountPaise: hold.amountPaise,
        } });
      })();
      const reclaim = (async () => {
        await prisma.$queryRaw`SELECT pg_sleep(0.025)::text`;
        return claim(1, ["A1"]);
      })();
      const results = await Promise.allSettled([confirmation, reclaim]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") expect(String(result.reason)).toMatch(/valid hold|seat conflict/);
      }
      expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
      await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
    }
  });
});

describe("durable payment, reset and diagnostic contracts", () => {
  it("rejects attempts on expired holds and retries after a successful attempt", async () => {
    const expired = await claim(0, ["A1"]);
    await expire(expired.id);
    await expect(prisma.paymentAttempt.create({ data: { holdId: expired.id, amountPaise: expired.amountPaise } }))
      .rejects.toThrow(/valid unpaid hold/);
    const live = await claim(1, ["A1"]);
    const attempt = await prisma.paymentAttempt.create({ data: { holdId: live.id, amountPaise: live.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    await expect(prisma.paymentAttempt.create({ data: { holdId: live.id, amountPaise: live.amountPaise } }))
      .rejects.toThrow(/valid unpaid hold/);
    await expect(prisma.refundRequired.create({ data: { paymentAttemptId: attempt.id, amountPaise: 1, reason: "late" } }))
      .rejects.toThrow(/unbooked successful attempt/);
    await prisma.refundRequired.create({ data: { paymentAttemptId: attempt.id, amountPaise: attempt.amountPaise, reason: "late" } });
    await expect(prisma.booking.create({ data: { holdId: live.id, screeningId, customerId: live.customerId,
      paymentAttemptId: attempt.id, amountPaise: live.amountPaise } }))
      .rejects.toThrow(/unrefunded successful payment/);
  });

  it("rejects refunds for failed or booked attempts and serializes refund versus booking", async () => {
    const failedHold = await claim(0, ["A1"]);
    const failed = await prisma.paymentAttempt.create({ data: { holdId: failedHold.id, amountPaise: failedHold.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'failed', finalized_at = now() WHERE id = ${failed.id}::uuid`;
    await expect(prisma.refundRequired.create({ data: { paymentAttemptId: failed.id, amountPaise: failed.amountPaise, reason: "late" } }))
      .rejects.toThrow(/unbooked successful attempt/);
    const booking = await confirm(await claim(1, ["A2"]));
    await expect(prisma.refundRequired.create({ data: {
      paymentAttemptId: booking.paymentAttemptId, amountPaise: booking.amountPaise, reason: "late",
    } })).rejects.toThrow(/unbooked successful attempt/);
    const live = await claim(2, ["A3"]);
    const attempt = await prisma.paymentAttempt.create({ data: { holdId: live.id, amountPaise: live.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    const outcomes = await Promise.allSettled([
      prisma.booking.create({ data: { holdId: live.id, screeningId, customerId: live.customerId,
        paymentAttemptId: attempt.id, amountPaise: live.amountPaise } }),
      prisma.refundRequired.create({ data: { paymentAttemptId: attempt.id, amountPaise: live.amountPaise, reason: "late" } }),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const result of outcomes) {
      if (result.status === "rejected") expect(String(result.reason)).toMatch(/unbooked successful attempt|unrefunded successful payment/);
    }
    expect((await checkSeatInvariants(prisma, screeningId)).ok).toBe(true);
  });

  it("takes over only an expired matching in-progress lease and stores only 2xx/4xx", async () => {
    const request = { screeningId, customerId: customers[0]!, operation: "hold.create", key: "lease", requestHash: "same" };
    const row = await prisma.idempotencyRecord.create({ data: request });
    expect(await takeOverStaleIdempotency(prisma, request)).toBeNull();
    await prisma.$executeRaw`UPDATE idempotency_records SET locked_until = now() - interval '1 second' WHERE id = ${row.id}::uuid`;
    expect(await takeOverStaleIdempotency(prisma, { ...request, requestHash: "different" })).toBeNull();
    const results = await Promise.all(Array.from({ length: 10 }, () => takeOverStaleIdempotency(prisma, request)));
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)?.leaseToken).toBeTruthy();
    await expect(prisma.idempotencyRecord.update({
      where: { id: row.id }, data: { status: "completed", responseCode: 302, responseBody: {} },
    })).rejects.toThrow(/idempotency_records_values_check/);
    await prisma.idempotencyRecord.update({ where: { id: row.id }, data: { status: "completed", responseCode: 409, responseBody: { conflict: true } } });
    await prisma.$executeRaw`UPDATE idempotency_records SET locked_until = now() - interval '1 second' WHERE id = ${row.id}::uuid`;
    expect(await takeOverStaleIdempotency(prisma, request)).toBeNull();
  });

  it("resets transient records without changing seat IDs or simulation history and refuses active simulations", async () => {
    const originalSeatIds = Object.values(seats).sort();
    const operator = await prisma.identity.findUniqueOrThrow({ where: { demoKey: "operator" } });
    const history = await prisma.simulationRun.create({ data: { screeningId, operatorId: operator.id, status: "completed", config: {} } });
    const live = await prisma.simulationRun.create({ data: { screeningId, operatorId: operator.id, status: "running", config: {} } });
    await expect(prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`)
      .rejects.toThrow(/cannot reset during an active simulation/);
    await prisma.simulationRun.update({ where: { id: live.id }, data: { status: "completed" } });
    const booking = await confirm(await claim(0, ["A1"]));
    await claim(1, ["A2"]);
    const late = await claim(2, ["A3"]);
    const attempt = await prisma.paymentAttempt.create({ data: { holdId: late.id, amountPaise: late.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    await prisma.refundRequired.create({ data: { paymentAttemptId: attempt.id, amountPaise: late.amountPaise, reason: "late" } });
    await prisma.paymentEvent.create({ data: { paymentAttemptId: attempt.id, providerEventId: "reset-event", outcome: "succeeded", payload: {} } });
    await prisma.idempotencyRecord.create({ data: { screeningId, customerId: customers[0]!, operation: "hold.create", key: "reset", requestHash: "hash" } });
    const other = await prisma.screening.create({ data: { title: "Retained", startsAt: new Date("2099-01-01"), durationMinutes: 180, seatPricePaise: SEAT_PRICE_PAISE } });
    await prisma.idempotencyRecord.create({ data: { screeningId: other.id, customerId: customers[0]!, operation: "hold.create", key: "other", requestHash: "hash" } });
    await prisma.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
    expect((await prisma.seat.findMany({ where: { screeningId } })).map((s) => s.id).sort()).toEqual(originalSeatIds);
    expect(await prisma.simulationRun.findUnique({ where: { id: history.id } })).not.toBeNull();
    expect(await prisma.simulationRun.count()).toBe(2);
    expect(await prisma.booking.count()).toBe(0);
    expect(await prisma.bookedSeat.count()).toBe(0);
    expect(await prisma.hold.count()).toBe(0);
    expect(await prisma.paymentAttempt.count()).toBe(0);
    expect(await prisma.paymentEvent.count()).toBe(0);
    expect(await prisma.refundRequired.count()).toBe(0);
    expect(await prisma.domainEvent.count()).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
    expect((await checkSeatInvariants(prisma, screeningId)).counts.available).toBe(100);
    const fresh = await confirm(await claim(0, ["A1"]));
    expect(fresh.id).not.toBe(booking.id);
    await expect(prisma.booking.delete({ where: { id: fresh.id } })).rejects.toThrow(/immutable/);
  });

  it("reports an injected confirmed hold with no booking", async () => {
    const hold = await claim(0, ["A1"]);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE holds DISABLE TRIGGER USER");
      await tx.$executeRaw`UPDATE holds SET status = 'confirmed' WHERE id = ${hold.id}::uuid`;
      await tx.$executeRawUnsafe("ALTER TABLE holds ENABLE TRIGGER USER");
    });
    expect((await checkSeatInvariants(prisma, screeningId)).violations).toContain("1 confirmed holds have no booking");
  });

  it("reports injected missing tickets and mismatching ticket totals", async () => {
    const booking = await confirm(await claim(0, ["A1", "A2"]));
    const ticket = await prisma.bookedSeat.findFirstOrThrow({ where: { bookingId: booking.id } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE booked_seats DISABLE TRIGGER USER");
      await tx.$executeRaw`DELETE FROM booked_seats WHERE id = ${ticket.id}::uuid`;
      await tx.$executeRawUnsafe("ALTER TABLE booked_seats ENABLE TRIGGER USER");
    });
    expect((await checkSeatInvariants(prisma, screeningId)).violations).toContain("1 bookings have inconsistent tickets or totals");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE booked_seats DISABLE TRIGGER USER");
      await tx.bookedSeat.create({ data: { ...ticket, pricePaise: 1 } });
      await tx.$executeRawUnsafe("ALTER TABLE booked_seats ENABLE TRIGGER USER");
    });
    expect(await prisma.bookedSeat.count({ where: { bookingId: booking.id } })).toBe(2);
    expect((await checkSeatInvariants(prisma, screeningId)).violations).toContain("1 bookings have inconsistent tickets or totals");
  });

  it("reports an injected refund and booking on the same attempt", async () => {
    const booking = await confirm(await claim(0, ["A1"]));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE refund_required DISABLE TRIGGER USER");
      await tx.refundRequired.create({ data: { paymentAttemptId: booking.paymentAttemptId, amountPaise: booking.amountPaise, reason: "corrupt" } });
      await tx.$executeRawUnsafe("ALTER TABLE refund_required ENABLE TRIGGER USER");
    });
    expect((await checkSeatInvariants(prisma, screeningId)).violations).toContain("1 payment attempts have both a booking and a refund");
  });

  it("reports injected multiple succeeded attempts for a hold", async () => {
    const hold = await claim(0, ["A1"]);
    const first = await prisma.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'failed', finalized_at = now() WHERE id = ${first.id}::uuid`;
    const second = await prisma.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
    await prisma.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${second.id}::uuid`;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("DROP INDEX payment_attempts_one_succeeded");
        await tx.$executeRawUnsafe("ALTER TABLE payment_attempts DISABLE TRIGGER USER");
        await tx.$executeRaw`UPDATE payment_attempts SET status = 'succeeded' WHERE id = ${first.id}::uuid`;
        await tx.$executeRawUnsafe("ALTER TABLE payment_attempts ENABLE TRIGGER USER");
      });
      expect((await checkSeatInvariants(prisma, screeningId)).violations).toContain("1 holds have multiple successful payment attempts");
    } finally {
      await prisma.paymentAttempt.delete({ where: { id: first.id } });
      await prisma.$executeRawUnsafe("CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_succeeded ON payment_attempts (hold_id) WHERE status = 'succeeded'");
    }
  });
});
