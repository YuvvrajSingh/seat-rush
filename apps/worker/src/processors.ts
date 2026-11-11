import type { Job } from "bullmq";
import type { Logger } from "pino";
import { QUEUE_NAMES, type QueueName } from "@seatrush/shared";
import type { PrismaClient } from "@seatrush/db";
import { processExpiryJob } from "./expiry.js";
import { processPaymentJob, type PaymentDeliveryOptions } from "./payments.js";
import { processRefundJob, reconcilePaymentJobs } from "./payment-sweeps.js";
import type { Queue } from "bullmq";

/** Handles one job. Must be safe to repeat: BullMQ delivers at least once (prd.md §12). */
export type Processor = (job: Job, token?: string) => Promise<unknown>;

export type ProcessorRegistry = Partial<Record<QueueName, Processor>>;

/** PostgreSQL-backed processors; queues without an entry get no BullMQ Worker. */
export function createProcessors(db: PrismaClient, logger: Logger, options: PaymentDeliveryOptions & { payments: Queue; refunds: Queue }): ProcessorRegistry {
  return {
    [QUEUE_NAMES.holdExpiry]: (job, token) => processExpiryJob(db, job, token, logger),
    [QUEUE_NAMES.paymentEvents]: (job, token) => processPaymentJob(job, token, logger, options),
    [QUEUE_NAMES.paymentReconciliation]: () => reconcilePaymentJobs(db, options.payments, options.refunds),
    [QUEUE_NAMES.refunds]: (job) => processRefundJob(db, job),
  };
}
