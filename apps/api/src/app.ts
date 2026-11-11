import express, { type Express } from "express";
import cors from "cors";
import type { Logger } from "pino";
import { REQUEST_ID_HEADER } from "@seatrush/shared";
import { requestId } from "./middleware/request-id.js";
import { httpLogger } from "./middleware/http-logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { healthRouter } from "./routes/health.js";
import { createOpenApiDocument } from "./openapi.js";
import { READINESS_TIMEOUT_MS, type ReadinessChecks } from "./readiness.js";
import { bookingRouter, type BookingDeps } from "./routes/booking.js";
import { paymentRouter, type PaymentDeps } from "./routes/payments.js";

export const JSON_BODY_LIMIT = "16kb";

export interface AppDeps extends BookingDeps, PaymentDeps {
  logger: Logger;
  readinessChecks: ReadinessChecks;
  /** Browser origin allowed by CORS. */
  webOrigin: string;
  /** Per-probe wait bound; defaults to {@link READINESS_TIMEOUT_MS}. */
  readinessTimeoutMs?: number;
}

/** Builds the Express app without binding a port or opening connections. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId());
  app.use(httpLogger(deps.logger));
  app.use(cors({ origin: deps.webOrigin, exposedHeaders: [REQUEST_ID_HEADER, "Retry-After"] }));
  app.use("/payments/notifications", express.raw({ type: "application/json", limit: JSON_BODY_LIMIT }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(
    healthRouter({
      readinessChecks: deps.readinessChecks,
      readinessTimeoutMs: deps.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
    }),
  );
  app.use(bookingRouter(deps));
  app.use(paymentRouter(deps));

  const openApiDocument = createOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
