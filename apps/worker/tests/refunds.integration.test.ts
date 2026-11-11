import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSeatsInTransaction, createPrismaClient, releaseHoldInTransaction } from "@seatrush/db";
import { QUEUE_NAMES, PAYMENT_JOB_NAMES, PAYMENT_JOB_OPTIONS, SeatEventSchema } from "@seatrush/shared";
import { processRefundJob, reconcilePaymentJobs, startPaymentSweeps } from "../src/payment-sweeps.js";
import { pino } from "pino";
import { createServer } from "node:http";
import { createApp } from "../../api/src/app.js";
import { createProcessors } from "../src/processors.js";
import { startWorkers } from "../src/workers.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || databaseUrl === process.env.DATABASE_URL) throw new Error("A separate TEST_DATABASE_URL is required");
const db = createPrismaClient(databaseUrl);
const cleanup: (() => Promise<unknown>)[] = [];
let screeningId: string;
let customerId: string;
let holdId: string;
let paymentAttemptId: string;
let attemptCreatedAt: number;
beforeEach(async () => {
  const customer = await db.identity.create({ data: { demoKey: `refund-worker-${randomUUID()}`, displayName: "Refund worker test", role: "customer" } });
  customerId = customer.id;
  const screening = await db.screening.create({ data: {
    title: "Worker refund", startsAt: new Date("2030-01-01T12:00:00Z"), durationMinutes: 180, seatPricePaise: 25_000,
    seats: { create: [{ label: "A1", row: "A", number: 1 }] },
  }, include: { seats: true } });
  screeningId = screening.id;
  const hold = await db.$transaction((tx) => claimSeatsInTransaction(tx, { screeningId, customerId, seatIds: [screening.seats[0]!.id] }));
  holdId = hold.id;
  const attempt = await db.paymentAttempt.create({ data: { holdId, amountPaise: 25_000, scenario: "success", delayMs: 0, createdAt: new Date(Date.now() - 60_000) } });
  paymentAttemptId = attempt.id;
  attemptCreatedAt = attempt.createdAt.getTime();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await db.$executeRaw`SELECT reset_demo_screening(${screeningId}::uuid)`;
  await db.seat.deleteMany({ where: { screeningId } });
  await db.screening.delete({ where: { id: screeningId } });
  await db.identity.delete({ where: { id: customerId } });
});
afterAll(() => db.$disconnect());

async function queues() {
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  cleanup.push(() => connection.quit());
  const prefix = `refund-worker-test-${randomUUID()}`;
  const payments = new Queue(QUEUE_NAMES.paymentEvents, { connection, prefix });
  const refunds = new Queue(QUEUE_NAMES.refunds, { connection, prefix });
  const reconciliation = new Queue(QUEUE_NAMES.paymentReconciliation, { connection, prefix });
  cleanup.push(async () => { await reconciliation.obliterate({ force: true }); await reconciliation.close(); });
  cleanup.push(async () => { await Promise.all([payments.obliterate({ force: true }), refunds.obliterate({ force: true })]); await Promise.all([payments.close(), refunds.close()]); });
  return { connection, prefix, payments, refunds, reconciliation };
}

async function requireRefund() {
  await db.$transaction((tx) => releaseHoldInTransaction(tx, holdId, customerId));
  await db.paymentAttempt.update({ where: { id: paymentAttemptId }, data: { status: "succeeded", finalizedAt: new Date() } });
  return db.refundRequired.create({ data: { paymentAttemptId, amountPaise: 25_000, reason: "hold_released" } });
}

describe("refund worker and durable reconciliation", () => {
  it("delivering a refund twice commits only one refund.completed event", async () => {
    const refund = await requireRefund();
    const { connection, prefix, refunds } = await queues();
    const worker = new Worker(QUEUE_NAMES.refunds, (job) => processRefundJob(db, job), { connection, prefix });
    worker.on("error", () => {});
    cleanup.push(() => worker.close());
    const first = await refunds.add("refund", { refundRequiredId: refund.id });
    await expect.poll(async () => {
      const stored = await refunds.getJob(first.id!);
      return await stored!.getState() === "failed" ? stored!.failedReason : stored!.getState();
    }).toBe("completed");
    const second = await refunds.add("refund", { refundRequiredId: refund.id });
    await expect.poll(() => second.getState()).toBe("completed");
    const state = await db.refundRequired.findUniqueOrThrow({ where: { id: refund.id } });
    expect(state.status).toBe("refunded");
    const events = await db.domainEvent.findMany({ where: { screeningId, kind: "refund.completed" } });
    expect(events).toHaveLength(1);
    expect(SeatEventSchema.parse(events[0]!.payload).kind).toBe("refund.completed");
  });

  it("recovers lost payment jobs without duplicating a live job", async () => {
    const { payments, refunds } = await queues();
    await reconcilePaymentJobs(db, payments, refunds);
    await reconcilePaymentJobs(db, payments, refunds);
    expect((await payments.getJob(paymentAttemptId))?.data).toEqual({ paymentAttemptId, scenario: "success", delayMs: 0, attemptCreatedAt });
    expect((await payments.getJob(paymentAttemptId))?.opts).toMatchObject(PAYMENT_JOB_OPTIONS);
    expect(await payments.getWaitingCount()).toBe(1);
    await (await payments.getJob(paymentAttemptId))!.remove();
    await reconcilePaymentJobs(db, payments, refunds);
    expect(await payments.getJob(paymentAttemptId)).toBeDefined();
  });

  it("repeatable reconciliation recovers a lost refund delivery", async () => {
    const refund = await requireRefund();
    const { connection, prefix, refunds, reconciliation } = await queues();
    const sweeps = await startPaymentSweeps({ connection, prefix, logger: pino({ level: "silent" }), intervalMs: 50 });
    cleanup.push(() => sweeps.close());
    expect(await reconciliation.getGlobalConcurrency()).toBe(1);
    const workers = startWorkers({
      connection, prefix, logger: pino({ level: "silent" }),
      processors: createProcessors(db, pino({ level: "silent" }), {
        payments: sweeps.payments, refunds: sweeps.refunds, webhookSecret: "refund-test-secret-at-least-32-characters", notificationUrl: "http://127.0.0.1:1",
      }),
    });
    cleanup.push(() => Promise.all(workers.map((worker) => worker.close())));
    await expect.poll(async () => (await db.refundRequired.findUniqueOrThrow({ where: { id: refund.id } })).status, { timeout: 5_000 }).toBe("refunded");
    expect(await refunds.getWaitingCount()).toBe(0);
  });

  it.each(["exhausted", "completed", "double-stall"] as const)("reconciles a retained %s job and confirms through the real API", async (mode) => {
    const { connection, prefix, payments, refunds, reconciliation } = await queues();
    const logger = pino({ level: "silent" });
    const secret = "recovery-real-api-secret-at-least-32-characters";
    const app = createApp({
      prisma: db, logger, authTokenSecret: secret, paymentWebhookSecret: secret,
      readinessChecks: { postgres: async () => {}, redis: async () => {} }, webOrigin: "http://localhost:3000",
    });
    let failures = mode === "exhausted" ? 5 : 0;
    const server = createServer((request, response) => {
      if (failures-- > 0) { response.writeHead(503).end(); return; }
      app(request, response);
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
    if (!address || typeof address === "string") throw new Error("No API address");
    const options = { payments, refunds, webhookSecret: secret, notificationUrl: `http://127.0.0.1:${address.port}/payments/notifications`, retryDelayMs: 10 };
    const processors = createProcessors(db, logger, options);
    const held = Promise.withResolvers<void>();
    const firstWorker = new Worker(QUEUE_NAMES.paymentEvents,
      mode === "exhausted" ? processors[QUEUE_NAMES.paymentEvents]! : async () => mode === "completed" ? undefined : held.promise,
      { connection, prefix, ...(mode === "double-stall" ? { concurrency: 3, lockDuration: 100, stalledInterval: 100, skipLockRenewal: true, maxStalledCount: 1 } : {}) });
    firstWorker.on("error", () => {});
    cleanup.push(async () => { await firstWorker.close(true); held.resolve(); });
    await payments.add(PAYMENT_JOB_NAMES.simulation, { paymentAttemptId, scenario: "success", delayMs: 0, attemptCreatedAt },
      { ...PAYMENT_JOB_OPTIONS, jobId: paymentAttemptId, removeOnComplete: false });
    await expect.poll(async () => (await payments.getJob(paymentAttemptId))?.getState(), { timeout: 5_000 }).toBe(mode === "completed" ? "completed" : "failed");
    if (mode === "double-stall") expect((await payments.getJob(paymentAttemptId))?.failedReason).toContain("stalled");
    await firstWorker.close(true);
    held.resolve();
    const workers = startWorkers({ connection, prefix, logger, processors });
    cleanup.push(() => Promise.all(workers.map((worker) => worker.close())));
    // Routing is by dedicated queue, not a magic producer job name.
    const sweep = await reconciliation.add("arbitrary-recovery-name", {});
    await expect.poll(() => sweep.getState(), { timeout: 5_000 }).toBe("completed");
    await expect.poll(async () => {
      const current = await payments.getJob(paymentAttemptId);
      if (current && await current.getState() === "failed") return current.failedReason;
      return db.booking.count({ where: { paymentAttemptId } });
    }, { timeout: 5_000 }).toBe(1);
    expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: paymentAttemptId } })).status).toBe("succeeded");
  });

  it.each(["failed", "completed"] as const)("replaces retained %s refund jobs", async (state) => {
    const refund = await requireRefund();
    const { connection, prefix, payments, refunds } = await queues();
    const firstWorker = new Worker(QUEUE_NAMES.refunds, async () => {
      if (state === "failed") throw new Error("Temporary refund outage");
    }, { connection, prefix });
    firstWorker.on("error", () => {});
    cleanup.push(() => firstWorker.close());
    const first = await refunds.add(PAYMENT_JOB_NAMES.refund, { refundRequiredId: refund.id }, { jobId: refund.id });
    await expect.poll(() => first.getState()).toBe(state);
    await firstWorker.close();
    await reconcilePaymentJobs(db, payments, refunds);
    const worker = new Worker(QUEUE_NAMES.refunds, (job) => processRefundJob(db, job), { connection, prefix });
    worker.on("error", () => {});
    cleanup.push(() => worker.close());
    await expect.poll(async () => (await db.refundRequired.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("refunded");
    expect(await db.domainEvent.count({ where: { screeningId, kind: "refund.completed" } })).toBe(1);
  });
});
