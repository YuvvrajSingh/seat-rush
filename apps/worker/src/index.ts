import { Redis } from "ioredis";
import { EnvValidationError, parseEnv, workerEnvSchema, type WorkerEnv } from "@seatrush/shared";
import { createLogger } from "./logger.js";
import { processors } from "./processors.js";
import { startWorkers } from "./workers.js";

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

// BullMQ requires maxRetriesPerRequest: null so blocking commands survive Redis reconnects.
const connection = new Redis(env.REDIS_URL, { connectionName: "seatrush-worker", maxRetriesPerRequest: null });
connection.on("error", (err) => logger.warn({ err }, "redis connection error"));

const workers = startWorkers({ processors, connection, logger });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  let exitCode = 0;
  // close() lets active jobs finish and stops fetching new ones.
  const results = await Promise.allSettled(workers.map((worker) => worker.close()));
  for (const result of results) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "error closing worker");
      exitCode = 1;
    }
  }
  if (connection.status === "ready") await connection.quit();
  else connection.disconnect();
  logger.info({ exitCode }, "shutdown complete");
  process.exit(exitCode);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await connection.ping();
logger.info(
  { queues: workers.map((worker) => worker.name) },
  workers.length === 0 ? "worker ready (no processors registered yet)" : "worker ready",
);
