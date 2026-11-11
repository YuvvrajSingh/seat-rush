import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createLogger, logRedisConnectionErrors } from "../src/logger.js";
import request from "supertest";
import { createPrismaClient } from "@seatrush/db";
import { createApp } from "../src/app.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, logger: createLogger({ level: "info", destination }) };
}

describe("createLogger redaction", () => {
  it("redacts notification signatures from real HTTP completion logs", async () => {
    const { lines, logger } = capture();
    const prisma = createPrismaClient("postgresql://unused:unused@localhost:1/unused");
    try {
      const app = createApp({ prisma, logger, authTokenSecret: "unused", paymentWebhookSecret: "webhook-secret",
        webOrigin: "http://localhost:3000", readinessChecks: { postgres: async () => {}, redis: async () => {} } });
      const signature = "a".repeat(64);
      expect((await request(app).post("/payments/notifications").set("x-seatrush-signature", signature).send({})).status).toBe(401);
      expect(JSON.stringify(lines)).not.toContain(signature);
      expect(lines).toContainEqual(expect.objectContaining({ req: expect.objectContaining({
        headers: expect.objectContaining({ "x-seatrush-signature": "[Redacted]" }),
      }) }));
    } finally { await prisma.$disconnect(); }
  });
  it("logs Redis connection errors once per outage and rearms after readiness", () => {
    const { lines, logger } = capture();
    const redis = new Redis({ lazyConnect: true });
    logRedisConnectionErrors(redis, logger, "redis unavailable");
    try {
      redis.emit("error", new Error("first connection failure"));
      redis.emit("error", new Error("retry connection failure"));
      expect(lines).toHaveLength(1);
      redis.emit("ready");
      redis.emit("error", new Error("new outage"));
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.msg === "redis unavailable")).toBe(true);
    } finally { redis.disconnect(); }
  });

  it("redacts auth headers and cookies on serialized requests", () => {
    const { lines, logger } = capture();
    logger.info({
      req: { headers: { authorization: "Bearer abc.def", cookie: "sid=1", "x-request-id": "r1" } },
      res: { headers: { "set-cookie": "sid=2" } },
    });
    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: "[Redacted]", cookie: "[Redacted]", "x-request-id": "r1" } },
      res: { headers: { "set-cookie": "[Redacted]" } },
    });
  });

  it("redacts tokens and payment fields at the top level and one level deep", () => {
    const { lines, logger } = capture();
    logger.info({
      token: "t0",
      payment: { cardNumber: "4111111111111111", cvv: "123", upiId: "a@upi", amountPaise: 40000 },
      customer: { accessToken: "t1", id: "c1" },
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of ["t0", "t1", "4111111111111111", "\"123\"", "a@upi"]) expect(text).not.toContain(secret);
    expect(lines[0]).toMatchObject({ payment: { amountPaise: 40000 }, customer: { id: "c1" } });
  });
});
