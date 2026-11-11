import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import type { Logger } from "pino";
import { PaymentSimulationJobSchema, type PaymentNotification } from "@seatrush/shared";
import { signPaymentNotification } from "@seatrush/shared/server";

export interface PaymentDeliveryOptions {
  notificationUrl: string;
  webhookSecret: string;
  /** Shortened by real-HTTP tests; production backoff starts at one second. */
  retryDelayMs?: number;
}

interface DeliveryProgress {
  step: number;
  failures: number;
  simulatedFailures: number;
  notBefore: number;
}

/** Stable IDs and timestamps survive lost acknowledgements and even complete queue reconstruction. */
export async function processPaymentJob(job: Job, token: string | undefined, logger: Logger, options: PaymentDeliveryOptions): Promise<void> {
  const parsed = PaymentSimulationJobSchema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError("Invalid payment simulation job");
  const { paymentAttemptId, scenario, delayMs, attemptCreatedAt } = parsed.data;
  const previous = job.progress;
  const progress: DeliveryProgress = typeof previous === "object" && previous !== null && "step" in previous
    ? previous as DeliveryProgress
    : { step: 0, failures: 0, simulatedFailures: 0, notBefore: scenario === "delayed_success" ? attemptCreatedAt + delayMs : 0 };
  await job.updateProgress(progress);
  if (progress.notBefore > Date.now()) {
    await job.moveToDelayed(progress.notBefore, token);
    throw new DelayedError();
  }
  const steps = scenario === "duplicate_success" || scenario === "out_of_order" ? 2 : 1;
  while (progress.step < steps) {
    const processing = scenario === "out_of_order" && progress.step === 1;
    const notification: PaymentNotification = {
      providerEventId: `${paymentAttemptId}-${processing ? "processing" : scenario === "failure" ? "failed" : "succeeded"}`,
      paymentAttemptId,
      outcome: processing ? "processing" : scenario === "failure" ? "failed" : "succeeded",
      // The earlier-generated processing notification is intentionally delivered last.
      occurredAt: new Date(attemptCreatedAt + (processing ? 0 : 1)).toISOString(),
    };
    const body = JSON.stringify(notification);
    let status: number | undefined;
    let simulatedFailure = false;
    try {
      if (scenario === "delivery_failure" && progress.simulatedFailures < 2) {
        progress.simulatedFailures++;
        simulatedFailure = true;
        throw new Error("Simulated payment notification transit failure");
      }
      const response = await fetch(options.notificationUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seatrush-signature": signPaymentNotification(options.webhookSecret, body), "x-request-id": notification.providerEventId },
        body,
        // Two-step scenarios still leave ample headroom inside a 10s shutdown grace period.
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      });
      status = response.status;
      await response.body?.cancel();
      if (status === 401) {
        logger.fatal({ paymentAttemptId, status }, "payment notification signature rejected; delivery will not retry");
        throw new UnrecoverableError("Payment notification signature rejected (401)");
      }
      if (status === 400 || status === 404 || status === 409) {
        throw new UnrecoverableError(`Permanent payment notification rejection (${status})`);
      }
      if (!response.ok) throw new Error("Payment notification HTTP failure");
    } catch (error) {
      if (error instanceof UnrecoverableError) throw error;
      if (!simulatedFailure) progress.failures++;
      const deliveryAttempt = simulatedFailure ? progress.simulatedFailures : progress.failures;
      progress.notBefore = Date.now() + (options.retryDelayMs ?? 1_000) * 2 ** (deliveryAttempt - 1);
      await job.updateProgress(progress);
      logger.warn({ err: error, paymentAttemptId, step: progress.step, deliveryAttempt, simulatedFailure, status }, "payment notification delivery failed");
      if (progress.failures >= 5) throw new UnrecoverableError("Payment notification delivery exhausted five attempts");
      await job.moveToDelayed(progress.notBefore, token);
      throw new DelayedError();
    }
    progress.step++;
    progress.failures = 0;
    progress.notBefore = 0;
    await job.updateProgress(progress);
    logger.info({ paymentAttemptId, step: progress.step, outcome: notification.outcome }, "payment notification delivered");
  }
}
