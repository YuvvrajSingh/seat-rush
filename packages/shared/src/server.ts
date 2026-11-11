import { createHmac, timingSafeEqual } from "node:crypto";

// Server-only helpers (`@seatrush/shared/server`). Kept out of the main entry so browser bundles
// never pull in node:crypto.

/** `hex(HMAC-SHA256(secret, rawBody))`, sent in PAYMENT_SIGNATURE_HEADER by the payment simulator. */
export function signPaymentNotification(secret: string, rawBody: string | Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time check of a hex signature over the exact raw request body. */
export function verifyPaymentNotification(secret: string, rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signPaymentNotification(secret, rawBody), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
