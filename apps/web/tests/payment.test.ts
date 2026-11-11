import { PaymentScenarioSchema, StartPaymentRequestSchema } from "@seatrush/shared";
import { describe, expect, it } from "vitest";
import {
  DELAYED_APPROVAL_MS,
  PAYMENT_POLL_MS,
  REFUND_POLL_MS,
  SCENARIO_OPTIONS,
  isStale,
  nextPollMs,
  payAction,
  paymentPhase,
  paymentRequest,
  phaseKey,
  scenarioOption,
} from "../src/lib/payment.js";
import { BOOKING_ID, makeAttempt } from "./fixtures.js";

const refund = (status: "required" | "processing" | "refunded") =>
  makeAttempt({ status: "succeeded", refund: { status, amountPaise: 40_000, reason: "hold_expired" } });

describe("scenario options", () => {
  it("offers every provider behaviour once, each with a label and a one-line explanation", () => {
    expect(SCENARIO_OPTIONS.map((option) => option.scenario).toSorted()).toEqual(
      PaymentScenarioSchema.options.toSorted(),
    );
    for (const option of SCENARIO_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.explanation).toMatch(/^[A-Z].*\.$/);
      expect(option.explanation).not.toContain("\n");
    }
  });

  it("names the delay in the delayed approval's label", () => {
    expect(scenarioOption("delayed_success").label).toBe(`Approve after ${DELAYED_APPROVAL_MS / 1000} seconds`);
  });
});

describe("paymentRequest", () => {
  it("sends a delay only with the delayed approval, and every request fits the contract", () => {
    expect(paymentRequest("delayed_success")).toEqual({ scenario: "delayed_success", delayMs: DELAYED_APPROVAL_MS });
    expect(paymentRequest("failure")).toEqual({ scenario: "failure" });
    for (const scenario of PaymentScenarioSchema.options) {
      expect(StartPaymentRequestSchema.safeParse(paymentRequest(scenario)).success).toBe(true);
    }
  });
});

describe("payAction", () => {
  it("is the same for a retry of the same payment and differs for another behaviour or hold", () => {
    const hold = "11111111-1111-4111-8111-111111111111";
    expect(payAction(hold, paymentRequest("success"))).toBe(payAction(hold, paymentRequest("success")));
    expect(payAction(hold, paymentRequest("success"))).not.toBe(payAction(hold, paymentRequest("failure")));
    expect(payAction(hold, paymentRequest("success"))).not.toBe(
      payAction("66666666-6666-4666-8666-666666666666", paymentRequest("success")),
    );
  });
});

describe("paymentPhase", () => {
  it("waits while the provider has not answered", () => {
    expect(paymentPhase(makeAttempt())).toEqual({ kind: "waiting" });
  });

  it("keeps waiting on a success the box office has not settled into a booking or refund", () => {
    expect(paymentPhase(makeAttempt({ status: "succeeded" }))).toEqual({ kind: "waiting" });
  });

  it("reports a decline, a booking and a refund", () => {
    expect(paymentPhase(makeAttempt({ status: "failed" }))).toEqual({ kind: "declined" });
    expect(paymentPhase(makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }))).toEqual({
      kind: "booked",
      bookingId: BOOKING_ID,
    });
    expect(paymentPhase(refund("processing"))).toEqual({
      kind: "refund",
      status: "processing",
      amountPaise: 40_000,
      reason: "hold_expired",
    });
  });

  it("tells refund steps apart so each is announced once", () => {
    expect(phaseKey(paymentPhase(refund("required")))).not.toBe(phaseKey(paymentPhase(refund("refunded"))));
  });
});

describe("nextPollMs", () => {
  it("asks every second while waiting and every two while a refund is under way", () => {
    expect(nextPollMs(makeAttempt())).toBe(PAYMENT_POLL_MS);
    expect(nextPollMs(makeAttempt({ status: "succeeded" }))).toBe(PAYMENT_POLL_MS);
    expect(nextPollMs(refund("required"))).toBe(REFUND_POLL_MS);
    expect(nextPollMs(refund("processing"))).toBe(REFUND_POLL_MS);
  });

  it("stops once the answer is final", () => {
    expect(nextPollMs(makeAttempt({ status: "failed" }))).toBeNull();
    expect(nextPollMs(makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }))).toBeNull();
    expect(nextPollMs(refund("refunded"))).toBeNull();
  });
});

describe("isStale", () => {
  it("rejects an answer showing less progress than one already applied", () => {
    expect(isStale(makeAttempt(), makeAttempt({ status: "failed" }))).toBe(true);
    expect(isStale(makeAttempt({ status: "succeeded" }), makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }))).toBe(true);
    expect(isStale(refund("required"), refund("processing"))).toBe(true);
  });

  it("accepts progress, repeats and other attempts", () => {
    expect(isStale(makeAttempt({ status: "failed" }), makeAttempt())).toBe(false);
    expect(isStale(refund("refunded"), refund("processing"))).toBe(false);
    expect(isStale(makeAttempt(), makeAttempt())).toBe(false);
    expect(isStale(makeAttempt({ id: "77777777-7777-4777-8777-777777777777" }), makeAttempt({ status: "failed" }))).toBe(false);
  });
});
