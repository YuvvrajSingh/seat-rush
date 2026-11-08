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

/** Pub/sub only distributes already-persisted observations; it never decides ownership. */
export const PUBSUB_CHANNELS = {
  conflicts: "seatrush:conflicts",
} as const;
