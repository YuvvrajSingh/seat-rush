import type { DependencyCheck, ReadinessResponse } from "@seatrush/shared";
import type { PrismaClient } from "@seatrush/db";
import type { Redis, RedisOptions } from "ioredis";

/** How long one readiness probe waits for each dependency. */
export const READINESS_TIMEOUT_MS = 1000;

/** Resolves when the dependency answers; rejects (or never settles) when it does not. */
export type ReadinessCheck = () => Promise<unknown>;

export interface ReadinessChecks {
  postgres: ReadinessCheck;
  redis: ReadinessCheck;
}

export type Dependency = keyof ReadinessChecks;

export interface ReadinessReport {
  ok: boolean;
  body: ReadinessResponse;
  failures: { dependency: Dependency; cause: unknown }[];
}

// Probe clients are bounded at the client level, so an abandoned probe cannot keep work running
// past its timeout. They are dedicated to probing: the bounds are too tight for request traffic.

/**
 * Adds pg `statement_timeout` (server side) and `query_timeout` (client side) to a connection
 * string for the readiness probe's own Prisma client.
 */
export function withProbeTimeouts(databaseUrl: string, timeoutMs: number): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("statement_timeout", String(timeoutMs));
  url.searchParams.set("query_timeout", String(timeoutMs));
  return url.toString();
}

/** ioredis options for the readiness probe's own Redis client. */
export function probeRedisOptions(timeoutMs: number): RedisOptions {
  return {
    connectionName: "seatrush-api-readiness",
    commandTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    // Fail immediately while disconnected instead of queueing commands until reconnect.
    enableOfflineQueue: false,
  };
}

export function postgresCheck(prisma: Pick<PrismaClient, "$queryRaw">): ReadinessCheck {
  return () => prisma.$queryRaw`select 1`;
}

export function redisCheck(redis: Pick<Redis, "ping">): ReadinessCheck {
  return () => redis.ping();
}

/** Concurrent callers share the outstanding call instead of starting another. */
function singleFlight(check: ReadinessCheck): ReadinessCheck {
  let inflight: Promise<unknown> | undefined;
  return () => {
    inflight ??= Promise.resolve()
      .then(check)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

const TIMED_OUT = Symbol("timed out");

async function runCheck(
  check: ReadinessCheck,
  timeoutMs: number,
): Promise<{ result: DependencyCheck; cause?: unknown }> {
  const started = performance.now();
  const latencyMs = () => Math.round(performance.now() - started);
  const timeout = Promise.withResolvers<typeof TIMED_OUT>();
  const timer = setTimeout(timeout.resolve, timeoutMs, TIMED_OUT);
  try {
    const outcome = await Promise.race([check(), timeout.promise]);
    if (outcome === TIMED_OUT) {
      return {
        result: { status: "down", latencyMs: latencyMs(), error: "timeout" },
        cause: new Error(`check timed out after ${timeoutMs}ms`),
      };
    }
    return { result: { status: "up", latencyMs: latencyMs() } };
  } catch (cause) {
    return { result: { status: "down", latencyMs: latencyMs(), error: "failed" }, cause };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns a probe that runs every check concurrently, each wait bounded by `timeoutMs`.
 * A check still outstanding from an earlier probe is joined, not restarted, so frequent
 * /readyz polling against a slow dependency keeps at most one call per dependency in flight.
 */
export function createReadinessProbe(checks: ReadinessChecks, timeoutMs: number): () => Promise<ReadinessReport> {
  const shared: ReadinessChecks = { postgres: singleFlight(checks.postgres), redis: singleFlight(checks.redis) };
  return async () => {
    const [postgres, redis] = await Promise.all([
      runCheck(shared.postgres, timeoutMs),
      runCheck(shared.redis, timeoutMs),
    ]);
    const failures: ReadinessReport["failures"] = [];
    if (postgres.result.status === "down") failures.push({ dependency: "postgres", cause: postgres.cause });
    if (redis.result.status === "down") failures.push({ dependency: "redis", cause: redis.cause });
    const ok = failures.length === 0;
    return {
      ok,
      body: { status: ok ? "ready" : "not_ready", checks: { postgres: postgres.result, redis: redis.result } },
      failures,
    };
  };
}
