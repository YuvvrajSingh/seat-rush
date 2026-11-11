import { MAX_SEATS_PER_HOLD } from "@seatrush/shared";
import type { FailureCode } from "./booking-api.js";
import { formatPaise } from "./money.js";

const seatList = new Intl.ListFormat("en-IN", { style: "long", type: "conjunction" });

/** "B7", "B7 and B8", "B7, B8 and B9". */
export function formatSeatList(labels: readonly string[]): string {
  return seatList.format(labels);
}

export interface FailureInput {
  code: FailureCode;
  /** Labels of the seats the server named as unavailable, if it named any. */
  takenLabels?: readonly string[];
  requestId?: string | undefined;
}

function reference(requestId: string | undefined): string {
  return requestId ? ` Reference ${requestId}.` : "";
}

/**
 * What to tell the customer when a hold request fails. Each message says what happened to their
 * seats and what to do next. Only codes where the server guarantees nothing was reserved say so.
 */
export function holdFailureMessage({ code, takenLabels = [], requestId }: FailureInput): string {
  switch (code) {
    case "seat_unavailable":
      return takenLabels.length > 0
        ? `${formatSeatList(takenLabels)} ${takenLabels.length === 1 ? "was" : "were"} just taken by another customer, so nothing was held. The rest of your selection is still chosen.`
        : "One of those seats was just taken by another customer, so nothing was held. Check the refreshed seat map and try again.";
    case "active_hold_exists":
      return "You already hold seats for this screening. Release them to choose different ones.";
    case "invalid_seats":
      return "Those seats are not part of this screening, so nothing was held. The seat map has been refreshed.";
    case "unauthorized":
      return "Your demo session had ended, so nothing was held. The page is starting a new one; try again in a moment.";
    case "retry_later":
      return "The box office was too busy to answer, so nothing was held. Try again.";
    case "rate_limited":
      return "This network has started too many demo sessions in the last minute, so nothing was held. Wait a minute and try again.";
    case "idempotency_in_progress":
      return "The box office is still working on your earlier request for these seats. Wait a moment and press Hold again; it will not hold them twice.";
    case "idempotency_key_reused":
      return "The box office matched this to an earlier, different request, so nothing new was held. Check the seat map and try again.";
    case "network":
      return "Lost contact with the box office before it answered. The seat map will show whether your seats were held, or press Hold again; it will not hold them twice.";
    default:
      return `The box office could not hold your seats.${reference(requestId)} Check the seat map before trying again.`;
  }
}

export function releaseFailureMessage({ code, requestId }: FailureInput): string {
  switch (code) {
    case "hold_not_active":
      return "That hold had already ended, so there was nothing to release.";
    case "not_found":
      return "That hold does not belong to this demo session, so it cannot be released here.";
    case "unauthorized":
      return "Your demo session had ended, so the hold could not be released. It will expire on its own.";
    case "retry_later":
      return "The box office is busy, so your seats are still held. Wait a few seconds and try again.";
    case "rate_limited":
      return "This network has started too many demo sessions in the last minute, so the release was not sent. Wait a minute and try again.";
    case "idempotency_in_progress":
      return "The box office is still working on your earlier release. Wait a moment and press Release again.";
    case "idempotency_key_reused":
      return "The box office matched this to an earlier, different request, so nothing changed. Try again.";
    case "network":
      return "Lost contact with the box office before it answered. The seat map will show whether your seats were released, or press Release again.";
    default:
      return `The box office could not release your seats.${reference(requestId)} Try again.`;
  }
}

export function heldMessage(labels: readonly string[], amountPaise: number): string {
  return `${formatSeatList(labels)} ${labels.length === 1 ? "is" : "are"} held for you. Total ${formatPaise(amountPaise)}.`;
}

export function releasedMessage(labels: readonly string[]): string {
  return `Released ${formatSeatList(labels)}. You no longer hold ${labels.length === 1 ? "it" : "them"}.`;
}

export function expiredMessage(labels: readonly string[]): string {
  return `Your hold on ${formatSeatList(labels)} ran out of time. Check the seat map to see what you can choose now.`;
}

/** The hold ended while the provider still had the payment: say what a late approval means. */
export function endedWhilePayingMessage(labels: readonly string[], how: "expired" | "released"): string {
  const ended =
    how === "expired"
      ? `Your hold on ${formatSeatList(labels)} ran out of time before the payment provider answered.`
      : `You released ${formatSeatList(labels)} before the payment provider answered.`;
  return `${ended} The seats are no longer yours, and if the payment is approved now it will be refunded.`;
}

export function takenFromSelectionMessage(labels: readonly string[]): string {
  return `${formatSeatList(labels)} ${labels.length === 1 ? "was" : "were"} just taken by another customer and left your selection.`;
}

/** What to tell the customer when starting a payment fails. Only the server's answer decides. */
export function paymentFailureMessage({ code, requestId }: FailureInput): string {
  switch (code) {
    case "payment_in_progress":
      return "A payment for these seats is already with the provider. Wait for its answer; it will show here.";
    case "already_confirmed":
      return "These seats are already paid for, so nothing was charged again. Retrieving your confirmation…";
    case "hold_not_active":
      return "Your hold had already ended, so no payment was started and nothing was charged. Check the seat map to see what you can choose now.";
    case "not_found":
      return "That hold does not belong to this demo session, so no payment was started.";
    case "unauthorized":
      return "Your demo session had ended, so no payment was started. Your hold stays with the old session and ends by itself.";
    case "retry_later":
      return "The box office was too busy to answer, so no payment was started. Try again; your seats are still held.";
    case "rate_limited":
      return "Too many requests from this network, so no payment was started. Wait a moment and try again.";
    case "idempotency_in_progress":
      return "The box office is still working on your earlier payment request. Wait a moment and press Pay again; it will not charge twice.";
    case "idempotency_key_reused":
      return "The box office matched this to an earlier, different request, so no payment was started. Try again.";
    case "network":
      return "Lost contact with the box office before it answered. Press Pay again to find out; it will not charge twice.";
    default:
      return `The box office could not start the payment.${reference(requestId)} Your seats are still held; try again.`;
  }
}

export function paymentStartedMessage(amountPaise: number): string {
  return `Payment of ${formatPaise(amountPaise)} sent. Waiting for the payment provider.`;
}

export function paymentDeclinedMessage(holdActive: boolean): string {
  return holdActive
    ? "The payment provider declined the payment, so nothing was taken. Your seats are still held; you can try again before the timer runs out."
    : "The payment provider declined the payment, so nothing was taken.";
}

export function bookedMessage(labels: readonly string[]): string {
  return labels.length > 0
    ? `Payment approved. ${formatSeatList(labels)} ${labels.length === 1 ? "is" : "are"} booked for you.`
    : "Payment approved. Your seats are booked.";
}

/** FR-05: a success that arrived after the hold ended. Says exactly what happened to seats and money. */
export function refundMessage(
  status: "required" | "processing" | "refunded",
  amountPaise: number,
  reason: "hold_expired" | "hold_released",
): string {
  const amount = formatPaise(amountPaise);
  const why =
    reason === "hold_expired"
      ? "The payment was approved after your hold had run out of time"
      : "The payment was approved after you released your seats";
  switch (status) {
    case "required":
      return `${why}, so the seats were not booked. A refund of ${amount} is due and will start shortly.`;
    case "processing":
      return `${why}, so the seats were not booked. Your refund of ${amount} is being processed.`;
    case "refunded":
      return `${why}, so the seats were not booked. ${amount} has been refunded.`;
  }
}

export const PAYMENT_RESULT_SHOWN_MESSAGE = "Press “Choose seats again” to pick new seats.";
export const PAYING_AFTER_HOLD_MESSAGE =
  "The payment provider has not answered yet. You can choose new seats once it does.";

export const SELECTION_LIMIT_MESSAGE = `You can hold up to ${MAX_SEATS_PER_HOLD} seats at once. Deselect one to choose another.`;
export const HOLD_ACTIVE_MESSAGE = "Release your held seats to choose different ones.";
