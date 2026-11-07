import { randomUUID } from "node:crypto";
import { Queue, type Job, type Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@seatrush/shared";
import { startWorkers } from "../src/workers.js";

// Real Redis from the root .env, isolated by a unique BullMQ prefix per test.
const { REDIS_URL } = process.env;
if (!REDIS_URL) throw new Error("REDIS_URL must be set (root .env)");

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe("startWorkers", () => {
  it("starts a worker only for queues with a registered processor and routes their jobs to it", async () => {
    const prefix = `test-${randomUUID()}`;
    const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    cleanup.push(() => connection.quit());

    const processed = Promise.withResolvers<Job>();
    const workers: Worker[] = startWorkers({
      processors: { [QUEUE_NAMES.refunds]: async (job) => processed.resolve(job) },
      connection,
      logger: pino({ level: "silent" }),
      prefix,
    });
    cleanup.push(() => Promise.all(workers.map((worker) => worker.close())));
    expect(workers.map((worker) => worker.name)).toEqual([QUEUE_NAMES.refunds]);

    const queue = new Queue(QUEUE_NAMES.refunds, { connection, prefix });
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    await queue.add("refund", { paymentAttemptId: "pa-1" });

    const job = await processed.promise;
    expect(job.queueName).toBe(QUEUE_NAMES.refunds);
    expect(job.data).toEqual({ paymentAttemptId: "pa-1" });
  });
});
