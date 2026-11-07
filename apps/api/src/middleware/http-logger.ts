import type { RequestHandler } from "express";
import type { Logger, SerializedRequest } from "pino";
import { pinoHttp } from "pino-http";

/**
 * Logged shape of a request. Query strings are dropped from `url` and `query` is omitted:
 * clients may put tokens or payment data there, and logs must never hold them (prd.md §12).
 */
export function serializeRequest(req: SerializedRequest) {
  const queryStart = req.url.indexOf("?");
  return {
    id: req.id,
    method: req.method,
    url: queryStart === -1 ? req.url : req.url.slice(0, queryStart),
    headers: req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
}

/** pino-http bound to the correlation id assigned by `requestId()`. */
export function httpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    serializers: { req: serializeRequest },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      return res.statusCode >= 400 ? "warn" : "info";
    },
  });
}
