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

export function takenFromSelectionMessage(labels: readonly string[]): string {
  return `${formatSeatList(labels)} ${labels.length === 1 ? "was" : "were"} just taken by another customer and left your selection.`;
}

export const SELECTION_LIMIT_MESSAGE = `You can hold up to ${MAX_SEATS_PER_HOLD} seats at once. Deselect one to choose another.`;
export const HOLD_ACTIVE_MESSAGE = "Release your held seats to choose different ones.";
