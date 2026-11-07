import type { Job } from "bullmq";
import type { QueueName } from "@seatrush/shared";

/** Handles one job. Must be safe to repeat: BullMQ delivers at least once (prd.md §12). */
export type Processor = (job: Job) => Promise<unknown>;

export type ProcessorRegistry = Partial<Record<QueueName, Processor>>;

/**
 * Processors by queue name. Each feature adds its entry when it lands (hold expiry, outbox
 * delivery, payment events, refunds); a queue without an entry gets no BullMQ Worker.
 */
export const processors: ProcessorRegistry = {};
