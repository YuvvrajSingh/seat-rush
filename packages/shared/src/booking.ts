import { z } from "zod";
import { MAX_SEATS_PER_HOLD, MIN_SEATS_PER_HOLD } from "./domain.js";

// Week-1 booking contract (prd.md FR-01, FR-02, FR-08, §9 live event contract).
// API validates requests/responses with these schemas and generates OpenAPI from them; the web app
// parses responses with them. Change them only with both API and web owners in the loop.

const isoDateTime = z.iso.datetime({ offset: true });
/** Postgres bigserial event id, carried as a decimal string (exceeds JS safe integers eventually). */
const eventId = z.string().regex(/^\d+$/);

// ── Auth (FR-08) ────────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/demo-session. The server picks a seeded demo customer and returns a signed bearer
 * token for it; clients cannot choose an identity. Operator sessions arrive with the simulator.
 */
export const DemoSessionResponseSchema = z
  .object({
    token: z.string().min(1),
    expiresAt: isoDateTime,
    customer: z.object({ id: z.uuid(), displayName: z.string() }),
  })
  .meta({ id: "DemoSessionResponse" });
export type DemoSessionResponse = z.infer<typeof DemoSessionResponseSchema>;

// ── Seat map snapshot (FR-01, §9) ───────────────────────────────────────────────────────────────

/** Public ownership state. "held" covers every unexpired active hold, whoever owns it. */
export const SeatStateSchema = z.enum(["available", "held", "confirmed"]);
export type SeatState = z.infer<typeof SeatStateSchema>;

export const SeatSnapshotSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    row: z.string().length(1),
    number: z.number().int().min(1),
    state: SeatStateSchema,
    /** True only when the authenticated viewer owns the hold on this seat. False when anonymous. */
    heldByYou: z.boolean(),
  })
  .meta({ id: "SeatSnapshot" });
export type SeatSnapshot = z.infer<typeof SeatSnapshotSchema>;

export const HoldStatusSchema = z.enum(["active", "expired", "released", "confirmed"]);
export type HoldStatus = z.infer<typeof HoldStatusSchema>;

export const HoldSchema = z
  .object({
    id: z.uuid(),
    screeningId: z.uuid(),
    /** Effective status decided by the database clock: an active hold past expiresAt is "expired". */
    status: HoldStatusSchema,
    seats: z.array(z.object({ id: z.uuid(), label: z.string() })).min(MIN_SEATS_PER_HOLD).max(MAX_SEATS_PER_HOLD),
    amountPaise: z.number().int().positive(),
    createdAt: isoDateTime,
    expiresAt: isoDateTime,
  })
  .meta({ id: "Hold" });
export type Hold = z.infer<typeof HoldSchema>;

/** GET /screenings/:screeningId/snapshot (bearer token optional). */
export const ScreeningSnapshotSchema = z
  .object({
    screening: z.object({
      id: z.uuid(),
      title: z.string(),
      startsAt: isoDateTime,
      durationMinutes: z.number().int().positive(),
      seatPricePaise: z.number().int().positive(),
    }),
    seats: z.array(SeatSnapshotSchema),
    counts: z.object({
      available: z.number().int().nonnegative(),
      held: z.number().int().nonnegative(),
      confirmed: z.number().int().nonnegative(),
    }),
    /** The viewer's active hold on this screening, or null (always null when anonymous). */
    yourHold: HoldSchema.nullable(),
    /** Highest domain event id reflected in this snapshot; "0" when none. SSE resumes after it. */
    lastEventId: eventId,
    /** Database clock at snapshot time, for client clock-skew correction. */
    serverTime: isoDateTime,
  })
  .meta({ id: "ScreeningSnapshot" });
export type ScreeningSnapshot = z.infer<typeof ScreeningSnapshotSchema>;

/** GET /screenings/demo → the seeded demo screening's id, so clients need no hard-coded UUID. */
export const DemoScreeningResponseSchema = z
  .object({ screeningId: z.uuid() })
  .meta({ id: "DemoScreeningResponse" });
export type DemoScreeningResponse = z.infer<typeof DemoScreeningResponseSchema>;

// ── Holds (FR-02, FR-03) ────────────────────────────────────────────────────────────────────────

/** POST /screenings/:screeningId/holds (bearer token required). 201 → Hold. */
export const CreateHoldRequestSchema = z
  .object({
    seatIds: z
      .array(z.uuid())
      .min(MIN_SEATS_PER_HOLD)
      .max(MAX_SEATS_PER_HOLD)
      .refine((ids) => new Set(ids).size === ids.length, { message: "seatIds must be unique" }),
  })
  .meta({ id: "CreateHoldRequest" });
export type CreateHoldRequest = z.infer<typeof CreateHoldRequestSchema>;

// GET /holds/:holdId → Hold (owner only; another customer's hold is 404, never 403, to avoid probing).
// DELETE /holds/:holdId → 200 Hold with status "released" (owner only; releasing a non-active hold is 409).

// ── Domain events (§9 live event contract) ──────────────────────────────────────────────────────

const eventBase = {
  id: eventId,
  screeningId: z.uuid(),
  /** Database clock when the change committed. */
  at: isoDateTime,
};
const seatRefs = z.array(z.object({ id: z.uuid(), label: z.string() })).min(1);

/** Public event shapes. Never carry customer identity; "held by you" is computed per subscriber. */
export const SeatEventSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...eventBase, kind: z.literal("hold.created"), holdId: z.uuid(), seats: seatRefs, expiresAt: isoDateTime }),
    z.object({ ...eventBase, kind: z.literal("hold.released"), holdId: z.uuid(), seats: seatRefs }),
    z.object({ ...eventBase, kind: z.literal("hold.expired"), holdId: z.uuid(), seats: seatRefs }),
  ])
  .meta({ id: "SeatEvent" });
export type SeatEvent = z.infer<typeof SeatEventSchema>;
export type SeatEventKind = SeatEvent["kind"];
