import { Router } from "express";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { HealthResponseSchema, ReadinessResponseSchema, type HealthResponse } from "@seatrush/shared";
import { createReadinessProbe, type ReadinessChecks } from "../readiness.js";
import { errorResponses } from "../openapi-responses.js";

export function registerHealthOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/healthz",
    tags: ["health"],
    summary: "Liveness: the process is up",
    responses: {
      200: { description: "Process is up", content: { "application/json": { schema: HealthResponseSchema } } },
      ...errorResponses,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/readyz",
    tags: ["health"],
    summary: "Readiness: Postgres and Redis respond",
    responses: {
      200: { description: "All dependencies up", content: { "application/json": { schema: ReadinessResponseSchema } } },
      503: {
        description: "At least one dependency down",
        content: { "application/json": { schema: ReadinessResponseSchema } },
      },
      ...errorResponses,
    },
  });
}

export function healthRouter(deps: { readinessChecks: ReadinessChecks; readinessTimeoutMs: number }): Router {
  const router = Router();
  const probeReadiness = createReadinessProbe(deps.readinessChecks, deps.readinessTimeoutMs);

  router.get("/healthz", (_req, res) => {
    const body: HealthResponse = { status: "ok" };
    res.set("Cache-Control", "no-store").json(body);
  });

  router.get("/readyz", async (req, res) => {
    const report = await probeReadiness();
    for (const { dependency, cause } of report.failures) {
      req.log.warn({ dependency, err: cause }, "readiness check failed");
    }
    res
      .status(report.ok ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json(report.body);
  });

  return router;
}
