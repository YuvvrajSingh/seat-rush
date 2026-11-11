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
  /** Serialized reconciliation is isolated from concurrent HTTP deliveries. */
  paymentReconciliation: "payment-reconciliation",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

export const PAYMENT_JOB_NAMES = {
  simulation: "payment.simulate",
  refund: "refund.complete",
  reconciliation: "payment.reconcile",
} as const;

/** Both producers use the same bounded infrastructure retry and retention policy. */
export const PAYMENT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;

/**
 * `payment-events` job: the worker's simulated provider plays out one attempt's scenario and
 * delivers signed notifications to the API. Producer: API on payment start (jobId = paymentAttemptId,
 * so re-enqueueing collapses) and the worker's stalled-attempt sweep. Losing a job never decides an
 * outcome; the sweep re-enqueues initiated attempts lacking an applied terminal notification (processing is non-terminal).
 */
export const PaymentSimulationJobSchema = z
  .object({
    paymentAttemptId: z.uuid(),
    scenario: PaymentScenarioSchema,
    delayMs: z.number().int().min(0).max(360_000),
    attemptCreatedAt: z.number().int().nonnegative().max(8_640_000_000_000_000 - 1),
  })
  .strict();
export type PaymentSimulationJob = z.infer<typeof PaymentSimulationJobSchema>;

/** `refunds` job: complete one refund-required record (required → processing → refunded), idempotently. */
export const RefundJobSchema = z.object({ refundRequiredId: z.uuid() }).strict();
export type RefundJob = z.infer<typeof RefundJobSchema>;

/** Pub/sub only distributes already-persisted observations; it never decides ownership. */
export const PUBSUB_CHANNELS = {
  conflicts: "seatrush:conflicts",
} as const;
