import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { QUEUE_NAMES, PAYMENT_JOB_NAMES, type PaymentNotification, type PaymentScenario } from "@seatrush/shared";
import { verifyPaymentNotification } from "@seatrush/shared/server";
import { processPaymentJob } from "../src/payments.js";
import { startWorkers } from "../src/workers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const secret = "worker-test-payment-secret-at-least-32";

async function setup(scenario: PaymentScenario, responses: number[] = [], delayMs = 0, retryDelayMs = 10) {
  const deliveries: PaymentNotification[] = [];
  const signatures: boolean[] = [];
  const logs: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    signatures.push(verifyPaymentNotification(secret, body, request.headers["x-seatrush-signature"] as string));
    deliveries.push(JSON.parse(body.toString()) as PaymentNotification);
    const status = responses.shift() ?? 200;
    if (status === 0) { request.socket.destroy(); return; }
    if (status === -1) return; // Deliberately hung receiver; the worker must time out.
    response.writeHead(status).end("{}");
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  cleanup.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    return closed.promise;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  cleanup.push(() => connection.quit());
  const prefix = `payments-test-${randomUUID()}`;
  const queue = new Queue(QUEUE_NAMES.paymentEvents, { connection, prefix });
  cleanup.push(async () => { await queue.obliterate({ force: true }); await queue.close(); });
  const logger = pino({}, { write: (line: string) => { logs.push(line); } });
  const [worker] = startWorkers({
    connection, prefix, logger,
    processors: { [QUEUE_NAMES.paymentEvents]: (job, token) => processPaymentJob(job, token, logger, {
      webhookSecret: secret, notificationUrl: `http://127.0.0.1:${address.port}`, retryDelayMs,
    }) },
  });
  if (!worker) throw new Error("Payment worker did not start");
  cleanup.push(() => worker.close());
  const job = await queue.add(PAYMENT_JOB_NAMES.simulation, { paymentAttemptId: randomUUID(), scenario, delayMs, attemptCreatedAt: Date.now() }, { attempts: 3, backoff: { type: "exponential", delay: 10 } });
  return { job, deliveries, signatures, logs, worker, queue, notificationUrl: `http://127.0.0.1:${address.port}` };
}

describe("simulated provider through real HTTP and Redis", () => {
  it.each(["success", "failure", "duplicate_success", "out_of_order", "delivery_failure"] as const)("delivers %s with valid raw-body signatures and stable identities", async (scenario) => {
    const { job, deliveries, signatures, logs } = await setup(scenario);
    await expect.poll(() => job.getState()).toBe("completed");
    expect(signatures.every(Boolean)).toBe(true);
    expect(deliveries.map((item) => item.outcome)).toEqual(scenario === "failure" ? ["failed"] : scenario === "out_of_order" ? ["succeeded", "processing"] : scenario === "duplicate_success" ? ["succeeded", "succeeded"] : ["succeeded"]);
    if (scenario === "duplicate_success") expect(deliveries[0]).toEqual(deliveries[1]);
    if (scenario === "out_of_order") expect(deliveries[1]!.occurredAt < deliveries[0]!.occurredAt).toBe(true);
    if (scenario === "delivery_failure") expect(logs.filter((line) => line.includes('"simulatedFailure":true'))).toHaveLength(2);
    expect(logs.join()).not.toContain(secret);
  });

  it.each([[503, 500], [0, 0]])("reuses notification IDs and bytes after delivery failures (%j)", async (first, second) => {
    const { job, deliveries } = await setup("success", [first, second]);
    await expect.poll(() => job.getState()).toBe("completed");
    expect(deliveries).toHaveLength(3);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(deliveries[2]).toEqual(deliveries[0]);
  });

  it("does not retry a rejected signature even when the producer allows retries", async () => {
    const { job, deliveries, logs } = await setup("success", [401]);
    await expect.poll(() => job.getState()).toBe("failed");
    expect(deliveries).toHaveLength(1);
    expect(logs.some((line) => line.includes('"level":60'))).toBe(true);
  });

  it("bounds delivery retries", async () => {
    const { job, deliveries } = await setup("success", Array(10).fill(503));
    await expect.poll(() => job.getState()).toBe("failed");
    expect(deliveries).toHaveLength(5);
  });

  it.each([400, 404, 409])("does not retry permanent HTTP %s", async (status) => {
    const { job, deliveries } = await setup("success", [status]);
    await expect.poll(() => job.getState()).toBe("failed");
    expect(deliveries).toHaveLength(1);
  });

  it("keeps the full real-failure budget after two simulated failures", async () => {
    const { job, deliveries, logs } = await setup("delivery_failure", [503, 503, 503, 503, 200]);
    await expect.poll(() => job.getState(), { timeout: 3_000 }).toBe("completed");
    expect(deliveries).toHaveLength(5);
    expect(logs.filter((line) => line.includes('"simulatedFailure":true'))).toHaveLength(2);
  });

  it("resumes the next persisted scenario step after restarting the worker", async () => {
    const { job, deliveries, worker, queue, notificationUrl } = await setup("duplicate_success", [200, 503], 0, 1_000);
    await expect.poll(() => job.getState()).toBe("delayed");
    expect(deliveries).toHaveLength(2);
    await worker.close();
    expect((await queue.getJob(job.id!))?.progress).toMatchObject({ step: 1, failures: 1 });
    const replacement = new Worker(QUEUE_NAMES.paymentEvents, (next, token) => processPaymentJob(next, token, pino({ level: "silent" }), {
      webhookSecret: secret, notificationUrl, retryDelayMs: 10,
    }), { connection: queue.opts.connection, ...(queue.opts.prefix === undefined ? {} : { prefix: queue.opts.prefix }) });
    replacement.on("error", () => {});
    cleanup.push(() => replacement.close());
    await expect.poll(() => job.getState(), { timeout: 3_000 }).toBe("completed");
    expect(deliveries).toHaveLength(3);
    expect(deliveries[2]).toEqual(deliveries[0]);
  });

  it("delays durably without blocking worker shutdown and resumes after restart", async () => {
    const { job, deliveries, worker, queue, notificationUrl } = await setup("delayed_success", [], 1_000);
    await expect.poll(() => job.getState()).toBe("delayed");
    const start = Date.now();
    await worker.close();
    expect(Date.now() - start).toBeLessThan(500);
    expect(deliveries).toHaveLength(0);
    // A fresh worker sees the persisted delayed wake-up, not a new timer.
    const replacement = new Worker(QUEUE_NAMES.paymentEvents, (next, token) => processPaymentJob(next, token, pino({ level: "silent" }), {
      webhookSecret: secret, notificationUrl, retryDelayMs: 10,
    }), { connection: queue.opts.connection, ...(queue.opts.prefix === undefined ? {} : { prefix: queue.opts.prefix }) });
    replacement.on("error", () => {});
    cleanup.push(() => replacement.close());
    await expect.poll(() => job.getState(), { timeout: 3_000 }).toBe("completed");
    expect(deliveries).toHaveLength(1);
  });

  it("does not let a hung receiver block unrelated payment attempts", async () => {
    const { job, deliveries, queue, worker } = await setup("success", [-1]);
    await expect.poll(() => deliveries.length).toBe(1);
    const others = await Promise.all(Array.from({ length: 5 }, () => queue.add(PAYMENT_JOB_NAMES.simulation, {
      paymentAttemptId: randomUUID(), scenario: "success", delayMs: 0, attemptCreatedAt: Date.now(),
    })));
    await expect.poll(async () => Promise.all(others.map((next) => next.getState())), { timeout: 1_000 }).toEqual(Array(5).fill("completed"));
    expect(await job.getState()).toBe("active");
    const started = Date.now();
    await worker.close();
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("rebuilding a delayed job preserves its original deadline and provider timestamp", async () => {
    const { job, deliveries, queue } = await setup("delayed_success", [], 500);
    await expect.poll(() => job.getState(), { timeout: 2_000 }).toBe("completed");
    await job.remove();
    const rebuilt = await queue.add(PAYMENT_JOB_NAMES.simulation, job.data);
    await expect.poll(() => rebuilt.getState(), { timeout: 400 }).toBe("completed");
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(deliveries[1]!.occurredAt).toBe(new Date(job.data.attemptCreatedAt + 1).toISOString());
  });
});
