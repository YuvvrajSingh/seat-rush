import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@seatrush/shared";
import { createExpiryQueue } from "../../api/src/expiry-queue.js";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for real Redis tests");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe("API expiry queue adapter", () => {
  it("enqueues a deduplicated delayed holdId job against real Redis", async () => {
    const prefix = `expiry-producer-test-${randomUUID()}`;
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    cleanup.push(() => connection.quit());
    const queue = new Queue(QUEUE_NAMES.holdExpiry, { connection, prefix });
    cleanup.push(async () => { await queue.obliterate({ force: true }); await queue.close(); });
    const producer = createExpiryQueue(redisUrl, pino({ level: "silent" }), prefix);
    cleanup.push(() => producer.close());
    const hold = { id: randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    cleanup.push(async () => { await (await queue.getJob(hold.id))?.remove(); });
    await expect.poll(async () => {
      await producer.enqueue(hold);
      return (await queue.getJob(hold.id))?.data;
    }).toEqual({ holdId: hold.id });
    await producer.enqueue(hold);
    const job = await queue.getJob(hold.id);
    expect(job?.name).toBe("expire");
    expect(await job?.getState()).toBe("delayed");
    expect(job!.delay).toBeGreaterThan(290_000);
    expect(job!.delay).toBeLessThanOrEqual(300_000);
    expect(job!.opts.jobId).toBe(hold.id);
  });

  it("logs and resolves promptly when Redis is unavailable, including close", async () => {
    // Reserve and release a local port, then use the real connection-refused path.
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const messages: string[] = [];
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    const logger = pino({ level: "warn" }, { write: (line: string) => { messages.push(line); } });
    const producer = createExpiryQueue(`redis://127.0.0.1:${address.port}`, logger);
    cleanup.push(() => producer.close());
    const started = performance.now();
    await expect(producer.enqueue({ id: randomUUID(), expiresAt: new Date() })).resolves.toBeUndefined();
    await producer.enqueue({ id: randomUUID(), expiresAt: new Date() });
    await producer.enqueue({ id: randomUUID(), expiresAt: new Date() });
    await producer.close();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(messages.filter((message) => message.includes("expiry enqueue unavailable; database sweep will recover"))).toHaveLength(1);
  });
});
