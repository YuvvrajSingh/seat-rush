import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { pino } from "pino";
import { afterEach, expect, it } from "vitest";
import { PAYMENT_JOB_NAMES, PAYMENT_JOB_OPTIONS, QUEUE_NAMES } from "@seatrush/shared";
import { createPaymentQueues } from "../src/payment-queues.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("enqueues stable provider creation time and common job names/options through real Redis", async () => {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");
  const prefix = `payment-producer-${randomUUID()}`;
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  cleanup.push(() => connection.quit());
  const payments = new Queue(QUEUE_NAMES.paymentEvents, { connection, prefix });
  const refunds = new Queue(QUEUE_NAMES.refunds, { connection, prefix });
  cleanup.push(async () => {
    await Promise.all([payments.obliterate({ force: true }), refunds.obliterate({ force: true })]);
    await Promise.all([payments.close(), refunds.close()]);
  });
  const producer = createPaymentQueues(process.env.REDIS_URL, pino({ level: "silent" }), prefix);
  cleanup.push(() => producer.close());
  const payment = { paymentAttemptId: randomUUID(), scenario: "delayed_success" as const, delayMs: 40_000, attemptCreatedAt: 1_794_000_000_123 };
  const refund = { refundRequiredId: randomUUID() };
  await expect.poll(async () => {
    await producer.enqueuePayment(payment);
    await producer.enqueueRefund(refund);
    return (await payments.getJob(payment.paymentAttemptId))?.data;
  }).toEqual(payment);
  await producer.enqueuePayment(payment);
  expect(await payments.getWaitingCount()).toBe(1);
  for (const [queue, id, name] of [[payments, payment.paymentAttemptId, PAYMENT_JOB_NAMES.simulation], [refunds, refund.refundRequiredId, PAYMENT_JOB_NAMES.refund]] as const) {
    const job = await queue.getJob(id);
    expect(job?.name).toBe(name);
    expect(job?.opts).toMatchObject(PAYMENT_JOB_OPTIONS);
  }
});
