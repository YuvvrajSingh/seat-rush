import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { ErrorCode, ErrorResponse } from "@seatrush/shared";

/** Throw (or pass to `next`) from a route to produce a controlled error response. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function sendError(req: Request, res: Response, status: number, code: ErrorCode, message: string): void {
  const body: ErrorResponse = { error: { code, message, requestId: String(req.id) } };
  res.status(status).json(body);
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(req, res, 404, "not_found", `No route for ${req.method} ${req.path}`);
};

/** Errors raised by express.json() (body-parser) carry a `type`. */
const BODY_PARSER_ERRORS: Record<string, { status: number; code: ErrorCode; message: string }> = {
  "entity.parse.failed": { status: 400, code: "invalid_json", message: "Request body is not valid JSON" },
  "entity.too.large": { status: 413, code: "payload_too_large", message: "Request body is too large" },
  "encoding.unsupported": { status: 415, code: "unsupported_media_type", message: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, code: "unsupported_media_type", message: "Unsupported charset" },
};

interface HttpLikeError {
  type?: unknown;
  status?: unknown;
  expose?: unknown;
  message?: unknown;
}

function classify(err: unknown): { status: number; code: ErrorCode; message: string } | undefined {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  if (typeof err !== "object" || err === null) return undefined;
  const httpErr = err as HttpLikeError;
  if (typeof httpErr.type === "string") {
    const known = BODY_PARSER_ERRORS[httpErr.type];
    if (known) return known;
  }
  // Other client errors that http-errors marks safe to expose.
  if (typeof httpErr.status === "number" && httpErr.status >= 400 && httpErr.status < 500 && httpErr.expose === true) {
    return { status: httpErr.status, code: "bad_request", message: String(httpErr.message) };
  }
  return undefined;
}

/** Centralized error handler: `{ error: { code, message, requestId } }`, never a stack trace. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const known = classify(err);
  if (known) {
    sendError(req, res, known.status, known.code, known.message);
    return;
  }
  // pino-http logs `res.err` with the completed request at error level.
  res.err = err instanceof Error ? err : new Error(String(err));
  sendError(req, res, 500, "internal_error", "Internal server error");
};
