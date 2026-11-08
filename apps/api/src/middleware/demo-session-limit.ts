import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

const WINDOW_MS = 60_000;
const MAX_SESSIONS = 10;

/** Per-process, per-socket-IP fixed window. Express does not trust forwarded IP headers. */
export function demoSessionLimit(): RequestHandler {
  const windows = new Map<string, { count: number; resetsAt: number }>();
  let nextPruneAt = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= nextPruneAt) {
      for (const [ip, window] of windows) if (window.resetsAt <= now) windows.delete(ip);
      nextPruneAt = now + WINDOW_MS;
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let window = windows.get(ip);
    if (!window || window.resetsAt <= now) {
      window = { count: 0, resetsAt: now + WINDOW_MS };
      windows.set(ip, window);
    }
    if (window.count >= MAX_SESSIONS) {
      res.set("Retry-After", String(Math.ceil((window.resetsAt - now) / 1000)));
      next(new HttpError(429, "rate_limited", "Demo sessions are limited to 10 per IP per minute"));
      return;
    }
    window.count++;
    next();
  };
}
