import { createServer } from "node:http";
import { Redis } from "ioredis";
import { createPrismaClient } from "@seatrush/db";
import { apiEnvSchema, EnvValidationError, parseEnv, type ApiEnv } from "@seatrush/shared";
import { createApp } from "./app.js";
import { createLogger } from "./logger.js";
import { postgresCheck, probeRedisOptions, READINESS_TIMEOUT_MS, redisCheck, withProbeTimeouts } from "./readiness.js";

/** In-flight requests get this long after SIGTERM/SIGINT before their sockets are destroyed. */
const SHUTDOWN_GRACE_MS = 10_000;

function loadEnv(): ApiEnv {
  try {
    return parseEnv(apiEnvSchema);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });

// Readiness-only clients with client-level timeouts (see readiness.ts). Request handlers get their
// own clients when booking routes land. While Redis is unreachable the API keeps serving and
// /readyz reports it (prd.md §12).
// Probes are single-flight per dependency, so one pooled connection suffices.
const probePrisma = createPrismaClient(withProbeTimeouts(env.DATABASE_URL, READINESS_TIMEOUT_MS), {
  max: 1,
  connectionTimeoutMillis: READINESS_TIMEOUT_MS,
});
const probeRedis = new Redis(env.REDIS_URL, probeRedisOptions(READINESS_TIMEOUT_MS));
probeRedis.on("error", (err) => logger.warn({ err }, "redis connection error"));

const app = createApp({
  logger,
  webOrigin: env.WEB_ORIGIN,
  readinessChecks: { postgres: postgresCheck(probePrisma), redis: redisCheck(probeRedis) },
});
const server = createServer(app);

async function closeDependencies(): Promise<void> {
  const results = await Promise.allSettled([
    probePrisma.$disconnect(),
    probeRedis.status === "ready" ? probeRedis.quit() : Promise.resolve(probeRedis.disconnect()),
  ]);
  for (const result of results) {
    if (result.status === "rejected") logger.error({ err: result.reason }, "error closing dependency");
  }
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const forceClose = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  forceClose.unref();
  let exitCode = 0;
  try {
    const closed = Promise.withResolvers<void>();
    server.close((err) => (err ? closed.reject(err) : closed.resolve()));
    await closed.promise;
  } catch (err) {
    logger.error({ err }, "error closing http server");
    exitCode = 1;
  }
  clearTimeout(forceClose);
  await closeDependencies();
  logger.info({ exitCode }, "shutdown complete");
  process.exit(exitCode);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

server.on("error", async (err) => {
  logger.fatal({ err }, "http server failed");
  await closeDependencies();
  process.exit(1);
});
server.listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, webOrigin: env.WEB_ORIGIN }, "api listening");
});
