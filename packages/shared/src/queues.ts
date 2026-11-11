import { z } from "zod";
import { PaymentScenarioSchema } from "./booking.js";

// BullMQ queue names shared by the API (producers) and worker (consumers).
// Queues only deliver work; PostgreSQL stays the authority for seat ownership (prd.md §11).

export const QUEUE_NAMES = {
  /** Idempotent tidy-up of holds whose `expires_at` has passed (FR-03). */
  holdExpiry: "hold-expiry",
  /** Delivery of committed outbox rows (prd.md §11, booking changes + events in one transaction). */
  outboxDelivery: "outbox-delivery",
  /** Simulated payment notifications, including duplicates and out-of-order delivery (FR-04). */
  paymentEvents: "payment-events",
  /** Idempotent simulated refunds for success-after-expiry (FR-05). */
  refunds: "refunds",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * `payment-events` job: the worker's simulated provider plays out one attempt's scenario and
 * delivers signed notifications to the API. Producer: API on payment start (jobId = paymentAttemptId,
 * so re-enqueueing collapses) and the worker's stalled-attempt sweep. Losing a job never decides an
 * outcome; the sweep re-enqueues initiated attempts that have no applied notification.
 */
export const PaymentSimulationJobSchema = z
  .object({ paymentAttemptId: z.uuid(), scenario: PaymentScenarioSchema, delayMs: z.number().int().min(0).max(360_000) })
  .strict();
export type PaymentSimulationJob = z.infer<typeof PaymentSimulationJobSchema>;

/** `refunds` job: complete one refund-required record (required → processing → refunded), idempotently. */
export const RefundJobSchema = z.object({ refundRequiredId: z.uuid() }).strict();
export type RefundJob = z.infer<typeof RefundJobSchema>;

/** Pub/sub only distributes already-persisted observations; it never decides ownership. */
export const PUBSUB_CHANNELS = {
  conflicts: "seatrush:conflicts",
} as const;
