import { Queue, UnrecoverableError, type ConnectionOptions, type Job } from "bullmq";
import type { Logger } from "pino";
import { completeRefund, findPendingRefunds, findStalledPaymentAttempts, type PrismaClient } from "@seatrush/db";
import { QUEUE_NAMES, PAYMENT_JOB_NAMES, PAYMENT_JOB_OPTIONS, RefundJobSchema } from "@seatrush/shared";

export async function processRefundJob(db: PrismaClient, job: Job): Promise<"completed" | "noop"> {
  const parsed = RefundJobSchema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError("Invalid refund job");
  return completeRefund(db, parsed.data.refundRequiredId);
}

/** Retained terminal jobs must not mask unfinished durable work after an outage or repeated stalls. */
async function recoverJob(queue: Queue, name: string, data: object, jobId: string): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.remove();
  }
  await queue.add(name, data, { ...PAYMENT_JOB_OPTIONS, jobId });
}

export async function reconcilePaymentJobs(db: PrismaClient, payments: Queue, refunds: Queue): Promise<void> {
  for (const data of await findStalledPaymentAttempts(db, { olderThanMs: 30_000, limit: 500 })) {
    await recoverJob(payments, PAYMENT_JOB_NAMES.simulation, data, data.paymentAttemptId);
  }
  for (const data of await findPendingRefunds(db, { limit: 500 })) {
    await recoverJob(refunds, PAYMENT_JOB_NAMES.refund, data, data.refundRequiredId);
  }
}

/** Durable wake-ups plus periodic scheduler repair recover producer failures and Redis data loss. */
export interface PaymentSweeps {
  payments: Queue;
  refunds: Queue;
  close(): Promise<void>;
}

export async function startPaymentSweeps(options: { connection: ConnectionOptions; logger: Logger; prefix?: string; intervalMs?: number }): Promise<PaymentSweeps> {
  const { logger, intervalMs = 30_000 } = options;
  const queueOptions = { connection: options.connection, ...(options.prefix === undefined ? {} : { prefix: options.prefix }) };
  const payments = new Queue(QUEUE_NAMES.paymentEvents, queueOptions);
  const refunds = new Queue(QUEUE_NAMES.refunds, queueOptions);
  const reconciliation = new Queue(QUEUE_NAMES.paymentReconciliation, queueOptions);
  for (const queue of [payments, refunds, reconciliation]) {
    let failed = false;
    queue.on("error", (err) => {
      if (failed) return;
      failed = true;
      logger.warn({ err, queue: queue.name }, "payment reconciliation queue unavailable");
    });
    queue.getBackend().on("ready", () => { failed = false; });
  }
  let pending: Promise<void> | undefined;
  let closed = false;
  let failed = false;
  function install(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      // Retire the old shared-queue scheduler during the clean cutover.
      await payments.removeJobScheduler("payment-reconciliation");
      await reconciliation.setGlobalConcurrency(1);
      await reconciliation.upsertJobScheduler("payment-reconciliation", { every: intervalMs }, {
        name: PAYMENT_JOB_NAMES.reconciliation, data: {}, opts: PAYMENT_JOB_OPTIONS,
      });
    })().then(() => { failed = false; }, (err: unknown) => {
      if (!failed) logger.warn({ err }, "could not register payment reconciliation sweep; will retry");
      failed = true;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  await install();
  const timer = setInterval(() => { void install(); }, intervalMs);
  timer.unref();
  return {
    payments, refunds,
    async close() {
      closed = true;
      clearInterval(timer);
      await pending;
      await Promise.all([payments.close(), refunds.close(), reconciliation.close()]);
    },
  };
}
