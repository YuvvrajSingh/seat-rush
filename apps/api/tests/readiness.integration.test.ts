import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "@seatrush/db";
import { createApp } from "../src/app.js";
import { postgresCheck, probeRedisOptions, redisCheck, withProbeTimeouts } from "../src/readiness.js";

// Real Postgres (TEST_DATABASE_URL) and Redis (REDIS_URL) from the root .env; no mocks.
const { TEST_DATABASE_URL, REDIS_URL } = process.env;
if (!TEST_DATABASE_URL || !REDIS_URL) throw new Error("TEST_DATABASE_URL and REDIS_URL must be set (root .env)");

const PROBE_TIMEOUT_MS = 300;

// Built exactly like src/index.ts builds its readiness clients.
let probePrisma: PrismaClient;
let probeRedis: Redis;

beforeAll(async () => {
  probePrisma = createPrismaClient(withProbeTimeouts(TEST_DATABASE_URL, PROBE_TIMEOUT_MS));
  // Without an offline queue, commands fail until connected, so connect before the tests.
  probeRedis = new Redis(REDIS_URL, { ...probeRedisOptions(PROBE_TIMEOUT_MS), lazyConnect: true });
  await probeRedis.connect();
});

afterAll(async () => {
  await probePrisma.$disconnect();
  probeRedis.disconnect();
});

function appWith(redisClient: Redis) {
  return createApp({
    logger: pino({ level: "silent" }),
    webOrigin: "http://localhost:3000",
    readinessChecks: { postgres: postgresCheck(probePrisma), redis: redisCheck(redisClient) },
    prisma: probePrisma,
    authTokenSecret: "test-secret-not-used-for-health-checks",
  });
}

describe("GET /readyz against real infrastructure", () => {
  it("returns 200 when Postgres and Redis answer", async () => {
    const res = await request(appWith(probeRedis)).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ready",
      checks: { postgres: { status: "up" }, redis: { status: "up" } },
    });
  });

  it("returns 503 when Redis is unreachable", async () => {
    const unreachable = new Redis("redis://127.0.0.1:1", { ...probeRedisOptions(PROBE_TIMEOUT_MS), retryStrategy: () => null });
    unreachable.on("error", () => {});
    try {
      const res = await request(appWith(unreachable)).get("/readyz");
      expect(res.status).toBe(503);
      expect(res.body.checks).toMatchObject({ postgres: { status: "up" }, redis: { status: "down" } });
    } finally {
      unreachable.disconnect();
    }
  });
});

describe("probe clients bound their own work", () => {
  it("adds pg timeouts to the probe connection string and keeps other parameters", () => {
    const url = new URL(withProbeTimeouts("postgresql://u:p@db:5432/seatrush?application_name=api", 750));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      application_name: "api",
      statement_timeout: "750",
      query_timeout: "750",
    });
  });

  it("aborts a slow Postgres query at the probe timeout and the pool stays usable", async () => {
    const started = Date.now();
    await expect(probePrisma.$queryRaw`select pg_sleep(3)`).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(probePrisma.$queryRaw`select 1 as ok`).resolves.toEqual([{ ok: 1 }]);
  });

  it("aborts a slow Redis command at the probe timeout", async () => {
    const started = Date.now();
    await expect(probeRedis.blpop(`seatrush-test:${randomUUID()}`, 3)).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
