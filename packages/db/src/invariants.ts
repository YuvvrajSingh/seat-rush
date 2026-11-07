import { TOTAL_SEATS } from "@seatrush/shared";
import type { PrismaClient } from "./client.js";

export interface SeatInvariantReport {
  ok: boolean;
  counts: { available: number; held: number; confirmed: number };
  violations: string[];
}

/** One statement gives the entire report a consistent PostgreSQL snapshot. */
export async function checkSeatInvariants(prisma: PrismaClient, screeningId: string): Promise<SeatInvariantReport> {
  const [result] = await prisma.$queryRaw<{
    available: number; held: number; confirmed: number; total: number;
    duplicateConfirmed: number; overlap: number; multipleHolds: number;
    ownerMismatch: number; invalidHolds: number; screeningExists: boolean;
    confirmedWithoutBooking: number; invalidBookings: number;
    refundWithBooking: number; multipleSuccesses: number;
  }[]>`
    WITH state AS (
      SELECT s.id, s.current_hold_id,
        (SELECT count(*) FROM hold_items hi JOIN holds h ON h.id = hi.hold_id
          WHERE hi.seat_id = s.id AND h.status = 'active' AND h.expires_at > now()) AS held,
        (SELECT count(*) FROM booked_seats bs WHERE bs.screening_id = s.screening_id AND bs.seat_id = s.id) AS confirmed,
        EXISTS (SELECT 1 FROM holds h WHERE h.id = s.current_hold_id AND h.status = 'active' AND h.expires_at > now()) AS live_pointer,
        EXISTS (SELECT 1 FROM hold_items hi JOIN holds h ON h.id = hi.hold_id
          WHERE hi.seat_id = s.id AND h.status = 'active' AND h.expires_at > now()
            AND h.id IS DISTINCT FROM s.current_hold_id) AS wrong_owner
      FROM seats s WHERE s.screening_id = ${screeningId}::uuid
    )
    SELECT count(*) FILTER (WHERE held = 0 AND confirmed = 0)::int AS available,
      count(*) FILTER (WHERE held > 0)::int AS held,
      count(*) FILTER (WHERE confirmed > 0)::int AS confirmed,
      count(*)::int AS total,
      count(*) FILTER (WHERE confirmed > 1)::int AS "duplicateConfirmed",
      count(*) FILTER (WHERE confirmed > 0 AND (held > 0 OR live_pointer))::int AS overlap,
      count(*) FILTER (WHERE held > 1)::int AS "multipleHolds",
      count(*) FILTER (WHERE wrong_owner OR (live_pointer AND held = 0))::int AS "ownerMismatch",
      (SELECT count(*)::int FROM holds h WHERE h.screening_id = ${screeningId}::uuid AND
        (h.seat_count <> (SELECT count(*) FROM hold_items hi WHERE hi.hold_id = h.id)
          OR h.amount_paise <> (SELECT coalesce(sum(price_paise), 0) FROM hold_items hi WHERE hi.hold_id = h.id))) AS "invalidHolds",
      (SELECT count(*)::int FROM holds h WHERE h.screening_id = ${screeningId}::uuid
        AND h.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.hold_id = h.id)) AS "confirmedWithoutBooking",
      (SELECT count(*)::int FROM bookings b JOIN holds h ON h.id = b.hold_id
        WHERE b.screening_id = ${screeningId}::uuid AND
          (h.status <> 'confirmed' OR h.seat_count <> (SELECT count(*) FROM booked_seats bs WHERE bs.booking_id = b.id)
            OR b.amount_paise <> (SELECT coalesce(sum(price_paise), 0) FROM booked_seats bs WHERE bs.booking_id = b.id))) AS "invalidBookings",
      (SELECT count(*)::int FROM bookings b JOIN refund_required r ON r.payment_attempt_id = b.payment_attempt_id
        WHERE b.screening_id = ${screeningId}::uuid) AS "refundWithBooking",
      (SELECT count(*)::int FROM holds h WHERE h.screening_id = ${screeningId}::uuid
        AND (SELECT count(*) FROM payment_attempts a WHERE a.hold_id = h.id AND a.status = 'succeeded') > 1) AS "multipleSuccesses",
      EXISTS (SELECT 1 FROM screenings WHERE id = ${screeningId}::uuid) AS "screeningExists"
    FROM state
  `;
  if (!result) throw new Error("invariant query returned no report");
  const counts = { available: result.available, held: result.held, confirmed: result.confirmed };
  const violations: string[] = [];
  if (!result.screeningExists) violations.push("Screening does not exist");
  if (result.total !== TOTAL_SEATS) violations.push(`Expected ${TOTAL_SEATS} seats, found ${result.total}`);
  if (counts.available + counts.held + counts.confirmed !== result.total) violations.push("Seat partition counts do not match inventory");
  if (result.duplicateConfirmed > 0) violations.push(`${result.duplicateConfirmed} seats confirmed more than once`);
  if (result.overlap > 0) violations.push(`${result.overlap} confirmed seats also actively held`);
  if (result.multipleHolds > 0) violations.push(`${result.multipleHolds} seats have overlapping active holds`);
  if (result.ownerMismatch > 0) violations.push(`${result.ownerMismatch} seats disagree with their active hold ownership`);
  if (result.invalidHolds > 0) violations.push(`${result.invalidHolds} holds have inconsistent items or amounts`);
  if (result.confirmedWithoutBooking > 0) violations.push(`${result.confirmedWithoutBooking} confirmed holds have no booking`);
  if (result.invalidBookings > 0) violations.push(`${result.invalidBookings} bookings have inconsistent tickets or totals`);
  if (result.refundWithBooking > 0) violations.push(`${result.refundWithBooking} payment attempts have both a booking and a refund`);
  if (result.multipleSuccesses > 0) violations.push(`${result.multipleSuccesses} holds have multiple successful payment attempts`);
  return { ok: violations.length === 0, counts, violations };
}
