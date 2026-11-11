import type { PaymentAttempt, PaymentScenario, RefundStatus, StartPaymentRequest } from "@seatrush/shared";

/**
 * Simulated payments (prd FR-04, FR-05). The provider is a demo: the customer picks how it
 * behaves, the server computes the amount, and only the server's answers change what is shown.
 */

/** Delay chosen for "approve after a delay": long enough to watch, well inside a 5-minute hold. */
export const DELAYED_APPROVAL_MS = 10_000;

export interface ScenarioOption {
  scenario: PaymentScenario;
  /** Plain-language name of the provider behaviour. */
  label: string;
  /** One line on what happens and what the customer will see. */
  explanation: string;
}

export const SCENARIO_OPTIONS: readonly ScenarioOption[] = [
  { scenario: "success", label: "Approve", explanation: "Approves straight away." },
  { scenario: "failure", label: "Decline", explanation: "Nothing is taken; you can try again while the hold lasts." },
  {
    scenario: "delayed_success",
    label: `Approve after ${DELAYED_APPROVAL_MS / 1000} seconds`,
    explanation: "Answers late while your hold keeps counting down.",
  },
  { scenario: "duplicate_success", label: "Approve twice", explanation: "Sends the same approval twice; it counts once." },
  {
    scenario: "out_of_order",
    label: "Approve out of order",
    explanation: "The approval overtakes an older “processing” message.",
  },
  {
    scenario: "delivery_failure",
    label: "Approve after lost deliveries",
    explanation: "The first two deliveries fail; the provider retries.",
  },
];

export const DEFAULT_SCENARIO: PaymentScenario = "success";

export function scenarioOption(scenario: PaymentScenario): ScenarioOption {
  const option = SCENARIO_OPTIONS.find((candidate) => candidate.scenario === scenario);
  if (!option) throw new Error(`Unknown payment scenario: ${scenario}`);
  return option;
}

/** Request body for a scenario; only the delayed approval carries a delay. */
export function paymentRequest(scenario: PaymentScenario): StartPaymentRequest {
  return scenario === "delayed_success" ? { scenario, delayMs: DELAYED_APPROVAL_MS } : { scenario };
}

/** Action identity for starting a payment: same hold and same request means the same action. */
export function payAction(holdId: string, request: StartPaymentRequest): string {
  return JSON.stringify(["pay", holdId, request.scenario, request.delayMs ?? null]);
}

/** What an attempt means for the customer, whatever order the provider's messages came in. */
export type PaymentPhase =
  /** No final answer yet, or a success the box office is still settling. */
  | { kind: "waiting" }
  | { kind: "declined" }
  | { kind: "booked"; bookingId: string }
  /** Success arrived after the hold ended: the seats were not booked and the money goes back (FR-05). */
  | { kind: "refund"; status: RefundStatus; amountPaise: number; reason: "hold_expired" | "hold_released" };

export function paymentPhase(attempt: Pick<PaymentAttempt, "status" | "bookingId" | "refund">): PaymentPhase {
  if (attempt.refund) return { kind: "refund", ...attempt.refund };
  if (attempt.bookingId) return { kind: "booked", bookingId: attempt.bookingId };
  if (attempt.status === "failed") return { kind: "declined" };
  return { kind: "waiting" };
}

/** Distinguishes refund progress too, so each step can be announced once. */
export function phaseKey(phase: PaymentPhase): string {
  return phase.kind === "refund" ? `refund:${phase.status}` : phase.kind;
}

export const PAYMENT_POLL_MS = 1_000;
export const REFUND_POLL_MS = 2_000;
/** After a failed poll (no answer, busy box office) wait a little longer before asking again. */
export const POLL_RETRY_MS = 2_000;

/**
 * How long to wait before asking about the attempt again, or null when its answer is final:
 * declined, booked, or refunded. A refund in progress keeps being asked about until it is done.
 */
export function nextPollMs(attempt: Pick<PaymentAttempt, "status" | "bookingId" | "refund">): number | null {
  const phase = paymentPhase(attempt);
  switch (phase.kind) {
    case "waiting":
      return PAYMENT_POLL_MS;
    case "refund":
      return phase.status === "refunded" ? null : REFUND_POLL_MS;
    case "declined":
    case "booked":
      return null;
  }
}

const REFUND_RANK: Record<RefundStatus, number> = { required: 0, processing: 1, refunded: 2 };

/**
 * True when `next` reports less progress than `current` for the same attempt, as a slow response
 * overtaken by a newer one would. Final states never change (FR-04), so such an answer is stale.
 */
export function isStale(next: PaymentAttempt, current: PaymentAttempt): boolean {
  if (next.id !== current.id) return false;
  if (current.status !== "initiated" && next.status === "initiated") return true;
  if (current.bookingId && !next.bookingId) return true;
  if (current.refund && (!next.refund || REFUND_RANK[next.refund.status] < REFUND_RANK[current.refund.status])) {
    return true;
  }
  return false;
}
