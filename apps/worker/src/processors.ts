import type { Job } from "bullmq";
import type { Logger } from "pino";
import { QUEUE_NAMES, type QueueName } from "@seatrush/shared";
import type { PrismaClient } from "@seatrush/db";
import { processExpiryJob } from "./expiry.js";

/** Handles one job. Must be safe to repeat: BullMQ delivers at least once (prd.md §12). */
export type Processor = (job: Job, token?: string) => Promise<unknown>;

export type ProcessorRegistry = Partial<Record<QueueName, Processor>>;

/** PostgreSQL-backed processors; queues without an entry get no BullMQ Worker. */
export function createProcessors(db: PrismaClient, logger: Logger): ProcessorRegistry {
  return { [QUEUE_NAMES.holdExpiry]: (job, token) => processExpiryJob(db, job, token, logger) };
}
