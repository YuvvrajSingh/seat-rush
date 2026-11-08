import { SeatEventSchema, type Hold, type SeatEvent, type SeatEventKind } from "@seatrush/shared";
import type { SqlTransaction } from "./seat-claims.js";

type EventHold = Pick<Hold, "id" | "screeningId" | "seats" | "expiresAt">;

/**
 * Commit a strict public hold event alongside its ownership change (§9, FR-03).
 * The ordered-events trigger locks the screening cursor last and supplies the id and DB clock.
 * Do not acquire any ownership locks after calling this function in a transaction.
 */
export async function emitHoldEvent(
  tx: SqlTransaction,
  kind: SeatEventKind,
  hold: EventHold,
  customerId: string,
): Promise<SeatEvent> {
  const payload = JSON.stringify({ kind, screeningId: hold.screeningId, holdId: hold.id, seats: hold.seats,
    ...(kind === "hold.created" ? { expiresAt: hold.expiresAt } : {}) });
  const [event] = await tx.$queryRaw<{ payload: unknown }[]>`
    INSERT INTO domain_events (screening_id, customer_id, kind, payload)
    VALUES (${hold.screeningId}::uuid, ${customerId}::uuid, ${kind}, ${payload}::jsonb)
    RETURNING payload`;
  // Invalid payloads throw before commit, rolling back ownership and the event together.
  return SeatEventSchema.parse(event?.payload);
}
