import { ApiError } from "./booking-api.js";

/**
 * Idempotency keys for hold and release (prd FR-06). One key per customer action; pressing the
 * button again for the same action after an unsettled answer resends the same key, so the server
 * replays its first answer instead of acting twice. Any settled answer retires the key.
 */
export interface ActionKeys {
  /** The key for this action: the pending one if the same action is being retried, else a new one. */
  keyFor(action: string): string;
  /** Records how the attempt with {@link keyFor}'s key ended; `error` is undefined on success. */
  settle(action: string, error?: unknown): void;
}

/**
 * True when the server may not have finished the action, or finished it without the client
 * learning the answer: no answer, 5xx (never stored, safe to resend), an unreadable 2xx, or
 * another execution still owning the key.
 */
export function isUnsettled(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.status === undefined ||
    error.status >= 500 ||
    error.code === "invalid_response" ||
    error.code === "idempotency_in_progress"
  );
}

export function createActionKeys(newKey: () => string = () => crypto.randomUUID()): ActionKeys {
  let pending: { action: string; key: string } | null = null;
  return {
    keyFor(action) {
      if (pending?.action !== action) pending = { action, key: newKey() };
      return pending.key;
    },
    settle(action, error) {
      if (pending?.action === action && (error === undefined || !isUnsettled(error))) pending = null;
    },
  };
}

/** Action identity for creating a hold: the server hashes the exact request, seat order included. */
export function holdAction(screeningId: string, seatIds: readonly string[]): string {
  return JSON.stringify(["hold", screeningId, seatIds]);
}

export function releaseAction(holdId: string): string {
  return JSON.stringify(["release", holdId]);
}
