import { z } from "zod";
import { MAX_SEATS_PER_HOLD, MIN_SEATS_PER_HOLD } from "./domain.js";

// Booking contract, Weeks 1–3 (prd.md FR-01..FR-08, §9 live event contract).
// API validates requests/responses with these schemas and generates OpenAPI from them; the web app
// parses responses with them. Change them only with both API and web owners in the loop.

const isoDateTime = z.iso.datetime({ offset: true });
/** Postgres bigserial event id, carried as a decimal string (exceeds JS safe integers eventually). */
const eventId = z.string().regex(/^\d+$/);

export const DemoSessionRequestSchema = z.object({}).strict().meta({ id: "DemoSessionRequest" });
export const ScreeningParamsSchema = z.object({ screeningId: z.uuid() }).meta({ id: "ScreeningParams" });
export const HoldParamsSchema = z.object({ holdId: z.uuid() }).meta({ id: "HoldParams" });

// ── Auth (FR-08) ────────────────────────────────────────────────────────────────────────────────

/**
 * POST /auth/demo-session creates a fresh web demo customer and returns a signed bearer
 * token for it; clients cannot choose an identity. Seeded customers are reserved for simulation.
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
    /**
     * Live hold metadata for timers and payment progress, irrespective of viewer ownership; null
     * unless held. `payment` is the latest attempt's status ("none" before any attempt).
     */
    hold: z
      .object({ id: z.uuid(), expiresAt: isoDateTime, payment: z.enum(["none", "initiated", "failed"]) })
      .nullable(),
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
    /** Committed screening event cursor, retained across reset; SSE resumes strictly after it. */
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
  .strict()
  .meta({ id: "CreateHoldRequest" });
export type CreateHoldRequest = z.infer<typeof CreateHoldRequestSchema>;

// GET /holds/:holdId → Hold (owner only; another customer's hold is 404, never 403, to avoid probing).
// DELETE /holds/:holdId → 200 Hold with status "released" (owner only; releasing a non-active hold is 409).

// ── Simulated payments (FR-04, FR-05, FR-06) ────────────────────────────────────────────────────

/**
 * Provider behaviour the simulator plays out for one attempt (FR-04). The browser picks the
 * behaviour; the server always computes the amount from the hold.
 * - success: one `succeeded` notification, delivered promptly.
 * - failure: one `failed` notification; the customer may retry while the hold is valid.
 * - delayed_success: `succeeded` delivered after `delayMs` (default 10 s). Payment never extends the hold.
 * - duplicate_success: the same `succeeded` notification (same providerEventId) delivered twice.
 * - out_of_order: `succeeded` delivered before an earlier-generated `processing` notification.
 * - delivery_failure: the first two deliveries of `succeeded` fail in transit and are retried.
 */
export const PaymentScenarioSchema = z.enum([
  "success",
  "failure",
  "delayed_success",
  "duplicate_success",
  "out_of_order",
  "delivery_failure",
]);
export type PaymentScenario = z.infer<typeof PaymentScenarioSchema>;

/** POST /holds/:holdId/payments (owner; Idempotency-Key required). 201 → PaymentAttempt. */
export const StartPaymentRequestSchema = z
  .object({
    scenario: PaymentScenarioSchema,
    /** Only for delayed_success: delivery delay in ms (0–360,000; default 10,000). */
    delayMs: z.number().int().min(0).max(360_000).optional(),
  })
  .strict()
  .meta({ id: "StartPaymentRequest" });
export type StartPaymentRequest = z.infer<typeof StartPaymentRequestSchema>;

export const PaymentParamsSchema = z.object({ paymentAttemptId: z.uuid() }).meta({ id: "PaymentParams" });

export const RefundStatusSchema = z.enum(["required", "processing", "refunded"]);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

/** GET /payments/:paymentAttemptId (owner only; others 404). */
export const PaymentAttemptSchema = z
  .object({
    id: z.uuid(),
    holdId: z.uuid(),
    /** initiated → succeeded | failed; final states never change (FR-04). */
    status: z.enum(["initiated", "succeeded", "failed"]),
    scenario: PaymentScenarioSchema,
    amountPaise: z.number().int().positive(),
    createdAt: isoDateTime,
    finalizedAt: isoDateTime.nullable(),
    /** Set when this attempt's success confirmed the booking. */
    bookingId: z.uuid().nullable(),
    /** Set when success arrived after the hold expired or was released (FR-05). */
    refund: z
      .object({ status: RefundStatusSchema, amountPaise: z.number().int().positive(), reason: z.enum(["hold_expired", "hold_released"]) })
      .nullable(),
  })
  .meta({ id: "PaymentAttempt" });
export type PaymentAttempt = z.infer<typeof PaymentAttemptSchema>;

// ── Confirmed bookings (FR-07) ──────────────────────────────────────────────────────────────────

export const BookingParamsSchema = z.object({ bookingId: z.uuid() }).meta({ id: "BookingParams" });

/** GET /bookings/:bookingId (owner only; others 404, never 403, prd §13 access denied). */
export const BookingSchema = z
  .object({
    id: z.uuid(),
    /** Human booking reference, e.g. "SR-…". */
    reference: z.string(),
    screening: z.object({ id: z.uuid(), title: z.string(), startsAt: isoDateTime, durationMinutes: z.number().int().positive() }),
    tickets: z
      .array(z.object({ seatId: z.uuid(), label: z.string(), ticketCode: z.string(), pricePaise: z.number().int().positive() }))
      .min(MIN_SEATS_PER_HOLD)
      .max(MAX_SEATS_PER_HOLD),
    amountPaise: z.number().int().positive(),
    confirmedAt: isoDateTime,
  })
  .meta({ id: "Booking" });
export type Booking = z.infer<typeof BookingSchema>;

// ── Payment-provider notifications (internal: simulator worker → API) ───────────────────────────

/** Header carrying `hex(HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, rawBody))`; see `@seatrush/shared/server`. */
export const PAYMENT_SIGNATURE_HEADER = "x-seatrush-signature";

/**
 * POST /payments/notifications body. `providerEventId` is unique per notification; redelivery of
 * the same notification reuses it (FR-06). 200 for accepted, duplicate or ignored notifications;
 * 401 invalid_signature; 503 retry_later (the simulator retries).
 */
export const PaymentNotificationSchema = z
  .object({
    providerEventId: z.string().min(1).max(200),
    paymentAttemptId: z.uuid(),
    outcome: z.enum(["processing", "succeeded", "failed"]),
    /** Provider clock when the notification was generated; informational only. */
    occurredAt: isoDateTime,
  })
  .strict()
  .meta({ id: "PaymentNotification" });
export type PaymentNotification = z.infer<typeof PaymentNotificationSchema>;

export const PaymentNotificationResultSchema = z
  .object({ disposition: z.enum(["applied", "duplicate", "ignored"]) })
  .meta({ id: "PaymentNotificationResult" });
export type PaymentNotificationResult = z.infer<typeof PaymentNotificationResultSchema>;

// ── Domain events (§9 live event contract) ──────────────────────────────────────────────────────

const eventBase = {
  id: eventId,
  screeningId: z.uuid(),
  /** Database clock at event insertion, immediately before the transaction commits. */
  at: isoDateTime,
};
const seatRefs = z.array(z.object({ id: z.uuid(), label: z.string() })).min(1);

/**
 * Public event shapes. Never carry customer identity; "held by you" is computed per subscriber.
 * Seat state changes only on hold.* and booking.confirmed. payment.* and refund.* never change seat
 * state; refund.required names the original hold's seats, which may now belong to someone else.
 */
export const SeatEventSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...eventBase, kind: z.literal("hold.created"), holdId: z.uuid(), seats: seatRefs, expiresAt: isoDateTime }).strict(),
    z.object({ ...eventBase, kind: z.literal("hold.released"), holdId: z.uuid(), seats: seatRefs }).strict(),
    z.object({ ...eventBase, kind: z.literal("hold.expired"), holdId: z.uuid(), seats: seatRefs }).strict(),
    z.object({ ...eventBase, kind: z.literal("payment.initiated"), holdId: z.uuid(), paymentAttemptId: z.uuid(), seats: seatRefs }).strict(),
    z.object({ ...eventBase, kind: z.literal("payment.failed"), holdId: z.uuid(), paymentAttemptId: z.uuid(), seats: seatRefs }).strict(),
    z.object({ ...eventBase, kind: z.literal("booking.confirmed"), holdId: z.uuid(), paymentAttemptId: z.uuid(), bookingId: z.uuid(), seats: seatRefs, amountPaise: z.number().int().positive() }).strict(),
    z.object({ ...eventBase, kind: z.literal("refund.required"), holdId: z.uuid(), paymentAttemptId: z.uuid(), seats: seatRefs, amountPaise: z.number().int().positive(), reason: z.enum(["hold_expired", "hold_released"]) }).strict(),
    z.object({ ...eventBase, kind: z.literal("refund.completed"), holdId: z.uuid(), paymentAttemptId: z.uuid(), amountPaise: z.number().int().positive() }).strict(),
    /** A notification recorded but not applied: a redelivered duplicate, or one for an already-final attempt. */
    z.object({ ...eventBase, kind: z.literal("payment.notification_ignored"), holdId: z.uuid(), paymentAttemptId: z.uuid(), reason: z.enum(["duplicate", "already_final"]) }).strict(),
  ])
  .meta({ id: "SeatEvent" });
export type SeatEvent = z.infer<typeof SeatEventSchema>;
export type SeatEventKind = SeatEvent["kind"];

// ── Conflict windows (§9; independent of the ownership-event cursor) ────────────────────────────

/** One seat's exact rejected-request count. No customer identity or inferred requested seats. */
export const ConflictWindowSchema = z
  .object({
    id: z.uuid(),
    kind: z.literal("seat.conflict"),
    screeningId: z.uuid(),
    seatId: z.uuid(),
    count: z.number().int().positive().max(2_147_483_647),
    /** API aggregation interval; explicit flush/shutdown may close a window early. */
    windowStartedAt: isoDateTime,
    windowEndedAt: isoDateTime,
    /** Database insertion clock, not an ownership change or an SSE resume cursor. */
    at: isoDateTime,
  })
  .strict()
  .refine((window) => Date.parse(window.windowEndedAt) >= Date.parse(window.windowStartedAt), {
    path: ["windowEndedAt"], message: "windowEndedAt must not precede windowStartedAt",
  })
  .meta({ id: "ConflictWindow" });
export type ConflictWindow = z.infer<typeof ConflictWindowSchema>;
