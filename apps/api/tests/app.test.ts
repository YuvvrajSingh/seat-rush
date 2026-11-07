import { pino } from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ErrorResponseSchema, ReadinessResponseSchema } from "@seatrush/shared";
import { createApp, type AppDeps } from "../src/app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const up = async () => undefined;

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: pino({ level: "silent" }),
    webOrigin: "http://localhost:3000",
    readinessChecks: { postgres: up, redis: up },
    ...overrides,
  });
}

describe("GET /healthz", () => {
  it("returns ok without touching dependencies", async () => {
    const failing = async () => {
      throw new Error("must not be called");
    };
    const res = await request(app({ readinessChecks: { postgres: failing, redis: failing } })).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /readyz with injected checks", () => {
  it("returns 200 when every check passes", async () => {
    const res = await request(app()).get("/readyz");
    expect(res.status).toBe(200);
    expect(ReadinessResponseSchema.parse(res.body).status).toBe("ready");
  });

  it("returns 503 with per-dependency status when a check rejects", async () => {
    const redisDown = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
    };
    const res = await request(app({ readinessChecks: { postgres: up, redis: redisDown } })).get("/readyz");
    expect(res.status).toBe(503);
    const body = ReadinessResponseSchema.parse(res.body);
    expect(body.status).toBe("not_ready");
    expect(body.checks.postgres.status).toBe("up");
    expect(body.checks.redis).toMatchObject({ status: "down", error: "failed" });
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
  });

  it("treats a check that throws synchronously as failed", async () => {
    const throwsSync = () => {
      throw new Error("boom");
    };
    const res = await request(app({ readinessChecks: { postgres: throwsSync, redis: up } })).get("/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks.postgres).toMatchObject({ status: "down", error: "failed" });
  });

  it("times out a hanging check", async () => {
    const hangs = () => new Promise<never>(() => {});
    const started = Date.now();
    const res = await request(app({ readinessChecks: { postgres: hangs, redis: up }, readinessTimeoutMs: 50 })).get(
      "/readyz",
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect(res.body.checks.postgres).toMatchObject({ status: "down", error: "timeout" });
    expect(res.body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(45);
    expect(res.body.checks.redis.status).toBe("up");
  });
});

describe("GET /readyz single-flight", () => {
  it("joins a check that is still outstanding instead of starting another", async () => {
    let calls = 0;
    const slow = Promise.withResolvers<void>();
    const postgres = () => {
      calls += 1;
      return slow.promise;
    };
    const server = app({ readinessChecks: { postgres, redis: up }, readinessTimeoutMs: 30 });

    const probes = await Promise.all([1, 2, 3].map(() => request(server).get("/readyz")));
    expect(probes.map((res) => res.status)).toEqual([503, 503, 503]);
    expect(calls).toBe(1);

    // Still outstanding: a later probe times out again without a second call.
    expect((await request(server).get("/readyz")).body.checks.postgres.error).toBe("timeout");
    expect(calls).toBe(1);

    // Once it settles, the next probe starts a fresh call.
    slow.resolve();
    await slow.promise;
    expect((await request(server).get("/readyz")).status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("correlation id", () => {
  it("generates a UUID when no x-request-id is sent", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("echoes a valid inbound x-request-id", async () => {
    const res = await request(app()).get("/healthz").set("x-request-id", "sim-run-7.req:42");
    expect(res.headers["x-request-id"]).toBe("sim-run-7.req:42");
  });

  it.each([["has spaces"], ["x".repeat(129)], ["<script>"]])("replaces an invalid inbound id (%s)", async (bad) => {
    const res = await request(app()).get("/healthz").set("x-request-id", bad);
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });
});

describe("errors", () => {
  it("returns a JSON 404 carrying the request id", async () => {
    const res = await request(app()).get("/nope").set("x-request-id", "req-404");
    expect(res.status).toBe(404);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({
      error: { code: "not_found", message: "No route for GET /nope", requestId: "req-404" },
    });
  });

  it("rejects malformed JSON with 400 invalid_json", async () => {
    const res = await request(app()).post("/anything").set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });

  it("rejects bodies over the JSON limit with 413", async () => {
    const res = await request(app())
      .post("/anything")
      .set("content-type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(17 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });
});

describe("CORS", () => {
  it("allows the web origin and exposes x-request-id", async () => {
    const res = await request(app()).get("/healthz").set("origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(res.headers["access-control-expose-headers"]).toBe("x-request-id");
  });

  it("answers preflight for the web origin", async () => {
    const res = await request(app())
      .options("/healthz")
      .set("origin", "http://localhost:3000")
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "content-type,authorization");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not grant other origins", async () => {
    const res = await request(app()).get("/healthz").set("origin", "http://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
  });
});

describe("GET /openapi.json", () => {
  it("documents the routes with components generated from the shared schemas", async () => {
    const res = await request(app()).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths)).toEqual(expect.arrayContaining(["/healthz", "/readyz", "/openapi.json"]));
    expect(Object.keys(res.body.components.schemas)).toEqual(
      expect.arrayContaining(["HealthResponse", "ReadinessResponse", "DependencyCheck", "ErrorResponse"]),
    );
    expect(res.body.paths["/readyz"].get.responses["503"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/ReadinessResponse",
    });
  });
});
