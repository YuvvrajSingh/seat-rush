import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { REQUEST_ID_HEADER } from "@seatrush/shared";

/** Inbound ids are accepted only if short and log-safe; anything else is replaced. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Assigns `req.id` (reused by pino-http) and echoes it in the `x-request-id` response header. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(REQUEST_ID_HEADER);
    const id = inbound !== undefined && VALID_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
