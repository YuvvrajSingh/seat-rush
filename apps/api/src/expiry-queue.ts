import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { QUEUE_NAMES } from "@seatrush/shared";
import { logRedisConnectionErrors } from "./logger.js";

export interface ExpiryQueue {
  enqueue(hold: { id: string; expiresAt: string | Date }): Promise<void>;
  close(): Promise<void>;
}

/** Best-effort wake-ups only; the worker's database sweep recovers every missed enqueue. */
export function createExpiryQueue(redisUrl: string, logger: Logger, prefix?: string): ExpiryQueue {
  const connection = new Redis(redisUrl, {
    connectionName: "seatrush-api-expiry",
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    autoResendUnfulfilledCommands: false,
  });
  logRedisConnectionErrors(connection, logger, "expiry redis connection error");
  let unavailable = false;
  connection.on("ready", () => { unavailable = false; });
  function logUnavailable(fields: { err?: unknown; holdId?: string }): void {
    if (unavailable) return;
    unavailable = true;
    logger.warn(fields, "expiry enqueue unavailable; database sweep will recover");
  }
  // Initialization must not issue INFO before a fail-fast connection is ready.
  const queue = new Queue(QUEUE_NAMES.holdExpiry, {
    connection, skipWaitingForReady: true, skipVersionCheck: true,
    ...(prefix === undefined ? {} : { prefix }),
  });
  queue.on("error", (err) => logUnavailable({ err }));
  let closed = false;
  return {
    async enqueue(hold): Promise<void> {
      // Do not let BullMQ/ioredis wait for a reconnect on the HTTP request path.
      if (closed || connection.status !== "ready") {
        logUnavailable({ holdId: hold.id });
        return;
      }
      try {
        // This delay only schedules tidy-up; cleanup_expired_hold uses PostgreSQL now().
        await queue.add("expire", { holdId: hold.id }, {
          jobId: hold.id,
          delay: Math.max(0, new Date(hold.expiresAt).getTime() - Date.now()),
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        });
      } catch (err) {
        logUnavailable({ err, holdId: hold.id });
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // No QUIT command: shutdown must also terminate promptly during a Redis outage.
      connection.disconnect();
      await queue.close();
    },
  };
}
