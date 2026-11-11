import { Redis } from "ioredis";
import type { Worker } from "bullmq";
import { createPrismaClient } from "@seatrush/db";
import { EnvValidationError, parseEnv, workerEnvSchema, type WorkerEnv } from "@seatrush/shared";
import { createLogger } from "./logger.js";
import { createProcessors } from "./processors.js";
import { startExpirySweep, type ExpirySweep } from "./expiry.js";
import { startWorkers } from "./workers.js";
import { startPaymentSweeps, type PaymentSweeps } from "./payment-sweeps.js";

function loadEnv(): WorkerEnv {
  try {
    return parseEnv(workerEnvSchema);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const prisma = createPrismaClient(env.DATABASE_URL);

// BullMQ requires maxRetriesPerRequest: null so blocking commands survive Redis reconnects.
const connection = new Redis(env.REDIS_URL, { connectionName: "seatrush-worker", maxRetriesPerRequest: null });
let redisFailed = false;
connection.on("ready", () => { redisFailed = false; });
connection.on("error", (err) => {
  if (redisFailed) return;
  redisFailed = true;
  logger.warn({ err }, "redis connection error");
});

const workers: Worker[] = [];
let sweep: ExpirySweep | undefined;
let paymentSweeps: PaymentSweeps | undefined;

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  // Leave headroom before Docker's 10s SIGKILL. Interrupted work is replayed from durable
  // job progress or DB reconciliation; no queue acknowledgement decides an ownership outcome.
  const deadline = setTimeout(() => {
    logger.error("worker shutdown deadline exceeded; unfinished work will be recovered");
    connection.disconnect();
    process.exit(1);
  }, 9_000);
  deadline.unref();
  let exitCode = 0;
  // close() lets active jobs finish and stops fetching new ones.
  if (sweep) {
    try { await sweep.close(); }
    catch (err) { logger.error({ err }, "error closing expiry sweep"); exitCode = 1; }
  }
  const results = await Promise.allSettled(workers.map((worker) => worker.close()));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "error closing worker");
      exitCode = 1;
    }
  }
  if (paymentSweeps) {
    try { await paymentSweeps.close(); }
    catch (err) { logger.error({ err }, "error closing payment sweeps"); exitCode = 1; }
  }
  if (connection.status === "ready") await connection.quit();
  else connection.disconnect();
  await prisma.$disconnect();
  clearTimeout(deadline);
  logger.info({ exitCode }, "shutdown complete");
  process.exit(exitCode);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await connection.ping();
sweep = await startExpirySweep({ connection, logger });
paymentSweeps = await startPaymentSweeps({ connection, logger });
workers.push(...startWorkers({
  processors: createProcessors(prisma, logger, {
    payments: paymentSweeps.payments,
    refunds: paymentSweeps.refunds,
    notificationUrl: env.PAYMENT_NOTIFICATION_URL,
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
  }),
  connection, logger,
}));
logger.info(
  { queues: workers.map((worker) => worker.name) },
  "worker ready",
);
