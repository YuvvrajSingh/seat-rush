import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { PrismaClient } from "@seatrush/db";
import { HttpError } from "./errors.js";

const TokenClaimsSchema = z.object({ v: z.literal(1), sub: z.uuid(), role: z.literal("customer"), exp: z.number().int().positive() }).strict();
export interface CustomerIdentity { id: string; role: "customer" }
declare global {
  namespace Express {
    interface Request { customer?: CustomerIdentity }
  }
}
const SESSION_SECONDS = 60 * 60;

export function issueCustomerToken(secret: string, customerId: string): { token: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: customerId, role: "customer", exp })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Fixed version/algorithm; authenticate the exact encoded bytes before interpreting claims. */
export function customerAuth(secret: string, required: boolean, prisma: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const authorization = req.get("authorization");
    if (!authorization && !required) { next(); return; }
    let claims: z.infer<typeof TokenClaimsSchema>;
    try {
      const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization ?? "");
      if (!match || authorization!.length > 2048) throw new Error("invalid token");
      const payload = match[1]!;
      const signature = Buffer.from(match[2]!, "ascii");
      const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"), "ascii");
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error("invalid signature");
      claims = TokenClaimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error("expired token");
    } catch {
      next(new HttpError(401, "unauthorized", "A valid customer bearer token is required"));
      return;
    }
    const identity = await prisma.identity.findUnique({ where: { id: claims.sub }, select: { role: true } });
    if (!identity || identity.role !== "customer") {
      next(new HttpError(401, "unauthorized", "A valid customer bearer token is required"));
      return;
    }
    req.customer = { id: claims.sub, role: "customer" };
    next();
  };
}
