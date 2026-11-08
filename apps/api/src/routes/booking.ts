import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { PrismaClient } from "@seatrush/db";
import { z } from "zod";
import { CreateHoldRequestSchema, DemoScreeningResponseSchema, DemoSessionRequestSchema, DemoSessionResponseSchema,
  HoldParamsSchema, HoldSchema, ScreeningParamsSchema, ScreeningSnapshotSchema, ErrorResponseSchema } from "@seatrush/shared";
import { createHoldInTransaction, deleteHold, deleteHoldInTransaction, getHold, getSnapshot } from "../booking.js";
import { idempotent } from "../idempotency.js";
import { customerAuth, issueCustomerToken } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { errorResponses } from "../openapi-responses.js";
import { demoSessionLimit } from "../middleware/demo-session-limit.js";

export interface BookingDeps {
  prisma: PrismaClient;
  authTokenSecret: string;
  enqueueExpiry?: (hold: { id: string; expiresAt: string }) => Promise<void>;
  conflicts?: { record(screeningId: string, seatIds: readonly string[]): void };
}
const idempotencyKey = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/);
const idempotencyHeaders = z.object({ "idempotency-key": idempotencyKey });
function parse<T>(schema: z.ZodType<T>, input: unknown, code: "bad_request" | "invalid_seats" = "bad_request"): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, code, "Invalid request");
  return parsed.data;
}

export function bookingRouter({ prisma, authTokenSecret, enqueueExpiry, conflicts }: BookingDeps): Router {
  const router = Router();
  const required = customerAuth(authTokenSecret, true, prisma);
  const optional = customerAuth(authTokenSecret, false, prisma);
  const noStore: RequestHandler = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

  router.post("/auth/demo-session", noStore, demoSessionLimit(), async (req, res) => {
    parse(DemoSessionRequestSchema, req.body ?? {});
    const customer = await prisma.identity.create({ data: {
      demoKey: `web-${randomUUID()}`, displayName: "Demo Customer", role: "customer",
    }, select: { id: true, displayName: true } });
    res.json(DemoSessionResponseSchema.parse({ customer, ...issueCustomerToken(authTokenSecret, customer.id) }));
  });
  router.get("/screenings/demo", noStore, async (_req, res) => {
    const screening = await prisma.screening.findUnique({ where: { demoKey: "demo-screening" }, select: { id: true } });
    if (!screening) throw new HttpError(404, "not_found", "Demo screening not found");
    res.json(DemoScreeningResponseSchema.parse({ screeningId: screening.id }));
  });
  router.get("/screenings/:screeningId/snapshot", noStore, optional, async (req, res) => {
    const { screeningId } = parse(ScreeningParamsSchema, req.params);
    res.json(await getSnapshot(prisma, screeningId, req.customer?.id ?? null));
  });
  router.post("/screenings/:screeningId/holds", noStore, required, async (req, res) => {
    const { screeningId } = parse(ScreeningParamsSchema, req.params, "invalid_seats");
    const key = parse(idempotencyKey, req.get("Idempotency-Key"));
    const result = await idempotent(prisma, { customerId: req.customer!.id, screeningId,
      operation: "hold.create", key, payload: { params: req.params, body: req.body }, requestId: String(req.id) }, async (tx, store) => {
      const body = parse(CreateHoldRequestSchema, req.body, "invalid_seats");
      return { status: 201, body: await createHoldInTransaction(tx, screeningId, req.customer!.id, body,
        (hold) => store({ status: 201, body: hold })) };
    });
    if (!result.replayed && result.status === 201) {
      const hold = HoldSchema.parse(result.body);
      await enqueueExpiry?.(hold);
    } else if (!result.replayed && result.status === 409) {
      const error = ErrorResponseSchema.parse(result.body).error;
      if (error.code === "seat_unavailable" && error.seatIds) conflicts?.record(screeningId, error.seatIds);
    }
    res.status(result.status).json(result.body);
  });
  router.get("/holds/:holdId", noStore, required, async (req, res) => {
    const { holdId } = parse(HoldParamsSchema, req.params);
    res.json(await getHold(prisma, holdId, req.customer!.id));
  });
  router.delete("/holds/:holdId", noStore, required, async (req, res) => {
    const { holdId } = parse(HoldParamsSchema, req.params);
    const rawKey = req.get("Idempotency-Key");
    if (rawKey === undefined) { res.json(await deleteHold(prisma, holdId, req.customer!.id)); return; }
    const key = parse(idempotencyKey, rawKey);
    const owned = await prisma.hold.findFirst({ where: { id: holdId, customerId: req.customer!.id }, select: { screeningId: true } });
    const result = await idempotent(prisma, { customerId: req.customer!.id, screeningId: owned?.screeningId ?? null,
      operation: "hold.release", key, payload: { params: req.params, body: req.body ?? null }, requestId: String(req.id) },
    async (tx, store) => ({ status: 200, body: await deleteHoldInTransaction(tx, holdId, req.customer!.id,
      (hold) => store({ status: 200, body: hold })) }));
    res.status(result.status).json(result.body);
  });
  return router;
}

export function registerBookingOpenApi(registry: OpenAPIRegistry): void {
  registry.registerComponent("securitySchemes", "CustomerBearer", { type: "http", scheme: "bearer", description: "HMAC-SHA256 signed demo session; expires after one hour" });
  const security = [{ CustomerBearer: [] }];
  const response = (schema: z.ZodType) => ({ description: "Success", content: { "application/json": { schema } } });
  const failures = {
    400: "bad_request / invalid_seats / invalid_json / payload_too_large",
    401: "unauthorized: missing, expired, forged or obsolete customer token",
    404: "not_found: unknown screening or hold (including another customer's hold)",
    409: "seat_unavailable / active_hold_exists / hold_not_active / idempotency_key_reused / idempotency_in_progress (Retry-After gives remaining lease seconds)",
    429: "rate_limited: maximum 10 demo-session attempts per IP per minute",
    503: "retry_later: database unavailable or bounded retry exhausted",
  };
  const errors = (...statuses: (keyof typeof failures)[]) => Object.fromEntries(statuses.map((status) =>
    [status, { description: failures[status], content: { "application/json": { schema: ErrorResponseSchema } } }]));
  registry.registerPath({ method: "post", path: "/auth/demo-session", tags: ["auth"],
    request: { body: { content: { "application/json": { schema: DemoSessionRequestSchema } } } },
    responses: { 200: response(DemoSessionResponseSchema), ...errors(400, 429, 503), ...errorResponses } });
  registry.registerPath({ method: "get", path: "/screenings/demo", tags: ["screenings"],
    responses: { 200: response(DemoScreeningResponseSchema), ...errors(404, 503), ...errorResponses } });
  registry.registerPath({ method: "get", path: "/screenings/{screeningId}/snapshot", tags: ["screenings"],
    security: [{}, ...security], request: { params: ScreeningParamsSchema },
    responses: { 200: response(ScreeningSnapshotSchema), ...errors(400, 401, 404, 503), ...errorResponses } });
  registry.registerPath({ method: "post", path: "/screenings/{screeningId}/holds", tags: ["holds"], security,
    request: { headers: idempotencyHeaders, params: ScreeningParamsSchema, body: { required: true, content: { "application/json": { schema: CreateHoldRequestSchema } } } },
    responses: { 201: response(HoldSchema), ...errors(400, 401, 404, 409, 503), ...errorResponses } });
  for (const method of ["get", "delete"] as const) registry.registerPath({ method, path: "/holds/{holdId}", tags: ["holds"], security,
    request: { params: HoldParamsSchema, ...(method === "delete" ? { headers: idempotencyHeaders.partial() } : {}) }, responses: { 200: response(HoldSchema), ...errors(400, 401, 404, 503),
      ...(method === "delete" ? errors(409) : {}), ...errorResponses } });
}
