import type { Hold } from "@seatrush/shared";

/**
 * Hold countdowns are informational (prd §6): the database clock decides expiry. The client only
 * estimates the server's "now" so the timer reads the same as the box office's.
 */

/**
 * Offset to add to the local clock to get server time, from one request that returned the
 * server's clock. The server read its clock somewhere between send and receive; the midpoint
 * halves the error that network latency would otherwise add.
 */
export function clockOffsetMs(serverTimeIso: string, sentAtMs: number, receivedAtMs: number): number {
  return Date.parse(serverTimeIso) - (sentAtMs + receivedAtMs) / 2;
}

/** Milliseconds left on a hold by the estimated server clock, never below zero. */
export function remainingMs(expiresAtIso: string, localNowMs: number, offsetMs: number): number {
  return Math.max(0, Date.parse(expiresAtIso) - (localNowMs + offsetMs));
}

export type CountdownState =
  | { phase: "counting"; remainingMs: number }
  /**
   * The estimate reached zero. Only the server can say whether the hold expired, so the UI waits
   * for it and never shows the seats as available on its own (prd §9).
   */
  | { phase: "checking" };

export function countdownState(
  hold: Pick<Hold, "status" | "expiresAt">,
  localNowMs: number,
  offsetMs: number,
): CountdownState {
  const left = remainingMs(hold.expiresAt, localNowMs, offsetMs);
  // A hold the server already marked as ended is not counting down, whatever the clock says.
  if (hold.status !== "active" || left === 0) return { phase: "checking" };
  return { phase: "counting", remainingMs: left };
}

/**
 * "m:ss", rounding up so the display shows 0:00 only once the estimate has really run out, and
 * a hold with 4 minutes 59.2 seconds left still reads 5:00.
 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Spoken form for the timer's accessible name, e.g. "4 minutes 5 seconds". */
export function describeRemaining(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}
