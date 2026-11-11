import { claimSeatsInTransaction, classifyDbError, emitHoldEvent, releaseHoldInTransaction, type PrismaClient, type SqlTransaction } from "@seatrush/db";
import { HoldSchema, ScreeningSnapshotSchema, type CreateHoldRequest, type Hold } from "@seatrush/shared";
import { HttpError } from "./middleware/errors.js";

function canonicalHold(hold: Hold): Hold {
  hold.createdAt = new Date(hold.createdAt).toISOString();
  hold.expiresAt = new Date(hold.expiresAt).toISOString();
  return hold;
}

export async function getHold(db: SqlTransaction, holdId: string, customerId: string): Promise<Hold> {
  const [row] = await db.$queryRaw<{ hold: unknown }[]>`
    SELECT jsonb_build_object('id', h.id, 'screeningId', h.screening_id,
      'status', CASE WHEN h.status = 'active' AND h.expires_at <= now() THEN 'expired' ELSE h.status END,
      'amountPaise', h.amount_paise, 'createdAt', h.created_at, 'expiresAt', h.expires_at,
      'latestPaymentAttemptId', (SELECT id FROM payment_attempts WHERE hold_id = h.id ORDER BY created_at DESC, id DESC LIMIT 1),
      'seats', (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label) ORDER BY s.row, s.number)
        FROM hold_items hi JOIN seats s ON s.id = hi.seat_id WHERE hi.hold_id = h.id)) AS hold
    FROM holds h WHERE h.id = ${holdId}::uuid AND h.customer_id = ${customerId}::uuid`;
  if (!row) throw new HttpError(404, "not_found", "Hold not found");
  return canonicalHold(HoldSchema.parse(row.hold));
}

/** Ownership, viewer hold, DB time and event cursor share a single MVCC statement snapshot. */
export async function getSnapshot(db: PrismaClient, screeningId: string, customerId: string | null) {
  const [row] = await db.$queryRaw<{ snapshot: unknown }[]>`
    WITH live_holds AS MATERIALIZED (
      SELECT h.*, p.id AS payment_id, coalesce(p.status, 'none') AS payment_status
      FROM holds h LEFT JOIN LATERAL (
        SELECT id, status FROM payment_attempts WHERE hold_id = h.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) p ON true
      WHERE h.screening_id = ${screeningId}::uuid AND h.status = 'active' AND h.expires_at > now()
    ), state AS (
      SELECT s.id, s.label, s.row, s.number,
        CASE WHEN EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id AND bs.screening_id = s.screening_id)
          THEN 'confirmed' WHEN h.id IS NOT NULL THEN 'held' ELSE 'available' END AS state,
        coalesce(h.customer_id = ${customerId}::uuid, false) AS yours, h.id AS hold_id, h.expires_at, h.payment_status
      FROM seats s LEFT JOIN live_holds h ON h.id = s.current_hold_id
      WHERE s.screening_id = ${screeningId}::uuid
    )
    SELECT jsonb_build_object(
      'screening', jsonb_build_object('id', sc.id, 'title', sc.title, 'startsAt', sc.starts_at,
        'durationMinutes', sc.duration_minutes, 'seatPricePaise', sc.seat_price_paise),
      'seats', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'row', row,
        'number', number, 'state', state, 'heldByYou', yours AND state = 'held',
        'hold', CASE WHEN state = 'held' THEN jsonb_build_object('id', hold_id, 'expiresAt', expires_at,
          'payment', payment_status) ELSE NULL END)
        ORDER BY row, number), '[]'::jsonb) FROM state),
      'counts', (SELECT jsonb_build_object('available', count(*) FILTER (WHERE state = 'available'),
        'held', count(*) FILTER (WHERE state = 'held'), 'confirmed', count(*) FILTER (WHERE state = 'confirmed')) FROM state),
      'yourHold', (SELECT jsonb_build_object('id', h.id, 'screeningId', h.screening_id, 'status', 'active',
        'amountPaise', h.amount_paise, 'createdAt', h.created_at, 'expiresAt', h.expires_at,
        'latestPaymentAttemptId', h.payment_id,
        'seats', (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label) ORDER BY s.row, s.number)
          FROM hold_items hi JOIN seats s ON s.id = hi.seat_id WHERE hi.hold_id = h.id))
        FROM live_holds h WHERE h.customer_id = ${customerId}::uuid),
      'lastEventId', (SELECT last_event_id::text FROM screening_event_cursors WHERE screening_id = sc.id),
      'serverTime', now()) AS snapshot
    FROM screenings sc WHERE sc.id = ${screeningId}::uuid`;
  if (!row) throw new HttpError(404, "not_found", "Screening not found");
  const snapshot = ScreeningSnapshotSchema.parse(row.snapshot);
  snapshot.screening.startsAt = new Date(snapshot.screening.startsAt).toISOString();
  snapshot.serverTime = new Date(snapshot.serverTime).toISOString();
  if (snapshot.yourHold) canonicalHold(snapshot.yourHold);
  for (const seat of snapshot.seats) if (seat.hold) seat.hold.expiresAt = new Date(seat.hold.expiresAt).toISOString();
  return snapshot;
}


/** SQL embeds the exact locked conflict set; never infer it from a later, racy read. */
function conflictingSeatIds(error: unknown): string[] | undefined {
  const text = error instanceof Error ? error.message : "";
  const match = /seat conflict: (\[[^\]\r\n]*\])/.exec(text);
  if (!match) return undefined;
  try {
    const ids: unknown = JSON.parse(match[1]!);
    if (Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))) return ids as string[];
  } catch { /* Missing adapter detail means the optional conflict set is unavailable. */ }
  return undefined;
}

export async function withDbRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      switch (classifyDbError(error)) {
        case "retryable":
          if (attempt === 0) continue;
          throw new HttpError(503, "retry_later", "Temporary database conflict; retry the request");
        case "seat_conflict":
          throw new HttpError(409, "seat_unavailable", "Some requested seats are unavailable", { seatIds: conflictingSeatIds(error) });
        case "active_hold_exists": throw new HttpError(409, "active_hold_exists", "Release your active hold before creating another");
        case "invalid_input": throw new HttpError(400, "invalid_seats", "Unknown screening or invalid seats");
        case "not_found": throw new HttpError(404, "not_found", "Screening not found");
        case "unauthorized": throw new HttpError(401, "unauthorized", "A valid customer bearer token is required");
        case "unavailable": throw new HttpError(503, "retry_later", "Database temporarily unavailable; retry the request");
        default: throw error;
      }
    }
  }
}

export async function createHoldInTransaction(tx: SqlTransaction, screeningId: string, customerId: string, request: CreateHoldRequest,
  beforeEvent?: (hold: Hold) => Promise<void>) {
  const claimed = await claimSeatsInTransaction(tx, { screeningId, customerId, seatIds: request.seatIds });
  const hold = HoldSchema.parse({ ...claimed, latestPaymentAttemptId: null, status: "active", createdAt: claimed.createdAt.toISOString(), expiresAt: claimed.expiresAt.toISOString() });
  await beforeEvent?.(hold);
  await emitHoldEvent(tx, "hold.created", hold, customerId);
  return hold;
}


export async function deleteHoldInTransaction(tx: SqlTransaction, holdId: string, customerId: string,
  beforeEvent?: (hold: Hold) => Promise<void>) {
  const before = await getHold(tx, holdId, customerId);
  if (before.status !== "active") throw new HttpError(409, "hold_not_active", "Hold is no longer active");
  const cleared = await releaseHoldInTransaction(tx, holdId, customerId);
  const hold = await getHold(tx, holdId, customerId);
  if (cleared === 0 || hold.status !== "released") throw new HttpError(409, "hold_not_active", "Hold is no longer active");
  await beforeEvent?.(hold);
  await emitHoldEvent(tx, "hold.released", hold, customerId);
  return hold;
}

export function deleteHold(db: PrismaClient, holdId: string, customerId: string) {
  return withDbRetry(() => db.$transaction((tx) => deleteHoldInTransaction(tx, holdId, customerId),
    { maxWait: 30_000, timeout: 30_000 }));
}
