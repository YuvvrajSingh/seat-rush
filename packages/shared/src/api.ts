import { z } from "zod";

// HTTP response contracts. The API validates against these and generates OpenAPI from them;
// `.meta({ id })` names the OpenAPI component.

/** Correlation id header carried by every request and echoed on every response (prd.md §12). */
export const REQUEST_ID_HEADER = "x-request-id";

export const HealthResponseSchema = z
  .object({ status: z.literal("ok") })
  .meta({ id: "HealthResponse", description: "Liveness: the API process is up." });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DependencyCheckSchema = z
  .object({
    status: z.enum(["up", "down"]),
    latencyMs: z.number().int().nonnegative(),
    error: z.enum(["timeout", "failed"]).optional(),
  })
  .meta({ id: "DependencyCheck" });
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

export const ReadinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.object({
      postgres: DependencyCheckSchema,
      redis: DependencyCheckSchema,
    }),
  })
  .meta({ id: "ReadinessResponse", description: "Readiness: 200 when every dependency is up, 503 otherwise." });
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const ERROR_CODES = [
  "bad_request",
  "invalid_json",
  "payload_too_large",
  "unsupported_media_type",
  "unauthorized",
  "not_found",
  /** 409: a requested seat is held or confirmed by someone else; nothing was reserved (FR-02). */
  "seat_unavailable",
  /** 409: the customer already has an active hold on this screening (FR-02). */
  "active_hold_exists",
  /** 409: the hold is not active (expired, released or confirmed). */
  "hold_not_active",
  /** 400: a seat id does not belong to this screening. */
  "invalid_seats",
  /** 503: a transient database conflict (deadlock/serialization); safe to retry. */
  "retry_later",
  "internal_error",
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      requestId: z.string(),
      /** For seat_unavailable: the requested seats that were not available, when known. */
      seatIds: z.array(z.uuid()).optional(),
    }),
  })
  .meta({ id: "ErrorResponse" });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
