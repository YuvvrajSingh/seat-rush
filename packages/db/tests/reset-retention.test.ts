import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_SEAT_LABELS } from "@seatrush/shared";
import { createPrismaClient } from "../src/client.js";
import { claimSeats, type SeatClaim } from "../src/seat-claims.js";
import { checkSeatInvariants } from "../src/invariants.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || databaseUrl === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
const prisma = createPrismaClient(databaseUrl);
let screeningId: string;
let otherScreeningId: string;
let customerId: string;
let seatId: string;
let otherSeatId: string;

beforeEach(async () => {
  const fixture = randomUUID();
  const customer = await prisma.identity.create({ data: {
    demoKey: `reset-retention-${fixture}`, displayName: "Reset retention", role: "customer",
  } });
  customerId = customer.id;
  const screenings = await Promise.all(["Reset", "Retained"].map((title) => prisma.screening.create({ data: {
    title: `${title} ${fixture}`, startsAt: new Date("2030-01-01T12:00:00Z"), durationMinutes: 180, seatPricePaise: 25_000,
    seats: { create: ALL_SEAT_LABELS.map((label) => ({
      label, row: label.charAt(0), number: Number(label.slice(1)),
    })) },
  }, include: { seats: true } })));
  screeningId = screenings[0]!.id;
  otherScreeningId = screenings[1]!.id;
  seatId = screenings[0]!.seats.find((seat) => seat.label === "A1")!.id;
  otherSeatId = screenings[1]!.seats.find((seat) => seat.label === "A1")!.id;
});

afterEach(async () => {
  for (const id of [screeningId, otherScreeningId]) {
    await prisma.$executeRaw`SELECT reset_demo_screening(${id}::uuid)`;
    await prisma.seat.deleteMany({ where: { screeningId: id } });
    await prisma.screening.delete({ where: { id } });
  }
  await prisma.idempotencyRecord.deleteMany({ where: { customerId } });
  await prisma.identity.delete({ where: { id: customerId } });
});
afterAll(async () => { await prisma.$disconnect(); });

async function confirm(hold: SeatClaim) {
  return prisma.$transaction(async (tx) => {
    const attempt = await tx.paymentAttempt.create({ data: { holdId: hold.id, amountPaise: hold.amountPaise } });
    await tx.$executeRaw`UPDATE payment_attempts SET status = 'succeeded', finalized_at = now() WHERE id = ${attempt.id}::uuid`;
    return tx.booking.create({ data: {
      holdId: hold.id, screeningId: hold.screeningId, customerId,
      paymentAttemptId: attempt.id, amountPaise: hold.amountPaise,
    } });
  });
}

describe("reset retention cleanup", () => {
  it("clears conflict windows and associated or recoverable hold responses without clearing unrelated records", async () => {
    const hold = await claimSeats(prisma, { screeningId, customerId, seatIds: [seatId] });
    const otherHold = await claimSeats(prisma, { screeningId: otherScreeningId, customerId, seatIds: [otherSeatId] });
    const createRecord = (key: string, association: string | null, body?: Record<string, string>) => prisma.idempotencyRecord.create({ data: {
      customerId, screeningId: association, operation: "hold.release", key, requestHash: "opaque-request-hash",
      ...(body ? { status: "completed", responseCode: 200, responseBody: body } : {}),
    } });
    const associated = await createRecord("associated", screeningId);
    const holdResponse = await createRecord("hold-response", null, {
      id: hold.id, screeningId, status: "released",
    });
    const historicalHoldResponse = await createRecord("hold-id-only", null, { id: hold.id });
    const holdIdResponse = await createRecord("holdId-only", null, { holdId: hold.id });
    const screeningResponse = await createRecord("screening-only", null, { screeningId });
    const otherAssociated = await createRecord("other-associated", otherScreeningId);
    const otherResponse = await createRecord("other-response", null, { id: otherHold.id, screeningId: otherScreeningId });
    const opaque = await createRecord("unresolvable", null);
    const malformed = await createRecord("malformed", null, { id: "not-a-uuid", screeningId: "not-a-uuid" });
    const windows = await Promise.all([
      { screeningId, seatId }, { screeningId: otherScreeningId, seatId: otherSeatId },
    ].map((seat) => prisma.conflictWindow.create({ data: {
      ...seat, count: 2, windowStartedAt: new Date("2026-01-01T00:00:00Z"), windowEndedAt: new Date("2026-01-01T00:00:00.100Z"),
    } })));
    await confirm(hold);
    const cursor = await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('seatrush.reset', 'off', true)`;
      await tx.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
      const [setting] = await tx.$queryRaw<{ value: string }[]>`SELECT current_setting('seatrush.reset') AS value`;
      expect(setting!.value).toBe("off");
    });
    expect(await prisma.idempotencyRecord.count({ where: { id: { in: [
      associated.id, holdResponse.id, historicalHoldResponse.id, holdIdResponse.id, screeningResponse.id,
    ] } } })).toBe(0);
    expect((await prisma.idempotencyRecord.findMany({ where: { customerId }, select: { id: true } }))
      .map((record) => record.id).sort()).toEqual([otherAssociated.id, otherResponse.id, opaque.id, malformed.id].sort());
    expect(await prisma.conflictWindow.findUnique({ where: { id: windows[0]!.id } })).toBeNull();
    expect(await prisma.conflictWindow.findUnique({ where: { id: windows[1]!.id } })).not.toBeNull();
    expect(await prisma.hold.findUnique({ where: { id: otherHold.id } })).not.toBeNull();
    expect(await prisma.seat.findUnique({ where: { id: seatId } })).toMatchObject({ currentHoldId: null });
    expect(await prisma.domainEvent.count({ where: { screeningId } })).toBe(0);
    expect((await prisma.screeningEventCursor.findUniqueOrThrow({ where: { screeningId } })).lastEventId).toBe(cursor.lastEventId);
    expect(await checkSeatInvariants(prisma, screeningId)).toEqual({
      ok: true, counts: { available: 100, held: 0, confirmed: 0 }, violations: [],
    });
    const fresh = await confirm(await claimSeats(prisma, { screeningId, customerId, seatIds: [seatId] }));
    await expect(prisma.booking.delete({ where: { id: fresh.id } })).rejects.toThrow(/immutable/);
  });

  it("restores the caller's existing reset setting rather than always disabling it", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('seatrush.reset', 'on', true)`;
      await tx.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
      const [setting] = await tx.$queryRaw<{ value: string }[]>`SELECT current_setting('seatrush.reset') AS value`;
      expect(setting!.value).toBe("on");
    });
  });
});
