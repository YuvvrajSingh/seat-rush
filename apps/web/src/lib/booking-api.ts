import {
  DemoScreeningResponseSchema,
  DemoSessionResponseSchema,
  ErrorResponseSchema,
  HoldSchema,
  REQUEST_ID_HEADER,
  ScreeningSnapshotSchema,
  type DemoSessionResponse,
  type ErrorCode,
  type Hold,
  type ScreeningSnapshot,
} from "@seatrush/shared";

/** The part of a zod schema the client needs; keeps zod itself out of this package's imports. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Why a call failed: an API error code, or one of the two ways the API never answered usefully. */
export type FailureCode = ErrorCode | "network" | "invalid_response";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly status?: number,
    /** For seat_unavailable: the requested seats that were not available, when the API knows. */
    readonly seatIds?: readonly string[],
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/** A parsed response plus when it was requested and received, for clock-skew estimates. */
export interface Timed<T> {
  body: T;
  sentAtMs: number;
  receivedAtMs: number;
}

export interface BookingApi {
  createDemoSession(): Promise<DemoSessionResponse>;
  getDemoScreening(): Promise<string>;
  getSnapshot(screeningId: string, token?: string): Promise<Timed<ScreeningSnapshot>>;
  /** `idempotencyKey` identifies one customer action; resend the same key only to retry that action. */
  createHold(screeningId: string, seatIds: readonly string[], token: string, idempotencyKey: string): Promise<Hold>;
  getHold(holdId: string, token: string): Promise<Hold>;
  releaseHold(holdId: string, token: string, idempotencyKey: string): Promise<Hold>;
}

interface CallOptions {
  method?: "GET" | "POST" | "DELETE";
  token?: string | undefined;
  idempotencyKey?: string;
  body?: unknown;
}

/**
 * Typed client for the Week-1 booking endpoints. Every response is validated against the shared
 * contract; every failure becomes an {@link ApiError} with a stable code.
 */
export function createBookingApi(
  baseUrl: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): BookingApi {
  async function call<T>(
    path: string,
    schema: Schema<T>,
    { method = "GET", token, idempotencyKey, body }: CallOptions = {},
  ): Promise<Timed<T>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      [REQUEST_ID_HEADER]: crypto.randomUUID(),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (body !== undefined) headers["content-type"] = "application/json";

    const sentAtMs = Date.now();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError("network", "The box office did not answer.");
    }
    const receivedAtMs = Date.now();
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    const json: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ApiError("invalid_response", `HTTP ${response.status}`, response.status, undefined, requestId);
      }
      const { code, message, seatIds, requestId: bodyRequestId } = parsed.data.error;
      throw new ApiError(code, message, response.status, seatIds, bodyRequestId);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("invalid_response", "The response did not match the booking contract.", response.status, undefined, requestId);
    }
    return { body: parsed.data, sentAtMs, receivedAtMs };
  }

  return {
    createDemoSession: async () =>
      (await call("/auth/demo-session", DemoSessionResponseSchema, { method: "POST", body: {} })).body,
    getDemoScreening: async () => (await call("/screenings/demo", DemoScreeningResponseSchema)).body.screeningId,
    getSnapshot: (screeningId, token) =>
      call(`/screenings/${encodeURIComponent(screeningId)}/snapshot`, ScreeningSnapshotSchema, { token }),
    createHold: async (screeningId, seatIds, token, idempotencyKey) =>
      (
        await call(`/screenings/${encodeURIComponent(screeningId)}/holds`, HoldSchema, {
          method: "POST",
          token,
          idempotencyKey,
          body: { seatIds },
        })
      ).body,
    getHold: async (holdId, token) => (await call(`/holds/${encodeURIComponent(holdId)}`, HoldSchema, { token })).body,
    releaseHold: async (holdId, token, idempotencyKey) =>
      (await call(`/holds/${encodeURIComponent(holdId)}`, HoldSchema, { method: "DELETE", token, idempotencyKey })).body,
  };
}
