import { describe, expect, it } from "vitest";
import { signPaymentNotification, verifyPaymentNotification } from "../src/server.js";

const secret = "0123456789abcdef0123456789abcdef";
const body = '{"providerEventId":"evt_1","outcome":"succeeded"}';

describe("payment notification signatures", () => {
  it("accepts the signature of the exact raw body", () => {
    expect(verifyPaymentNotification(secret, body, signPaymentNotification(secret, body))).toBe(true);
  });

  it("rejects a body changed after signing", () => {
    const signature = signPaymentNotification(secret, body);
    expect(verifyPaymentNotification(secret, body.replace("succeeded", "failed"), signature)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyPaymentNotification(secret, body, signPaymentNotification(`${secret}x`, body))).toBe(false);
  });

  it.each([undefined, "", "zz", signPaymentNotification(secret, body).toUpperCase()])("rejects malformed signature %s", (signature) => {
    expect(verifyPaymentNotification(secret, body, signature)).toBe(false);
  });
});
