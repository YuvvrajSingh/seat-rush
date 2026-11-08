import type { Hold } from "@seatrush/shared";
import { ApiError } from "./booking-api.js";

export type HoldCheckResult = { type: "hold-status"; hold: Hold } | { type: "hold-gone"; holdId: string };

/**
 * Asks the server what became of a hold the snapshot stopped listing. At most one request per hold
 * id is in flight: newer snapshots asking again while it runs do not start or cancel anything, so a
 * slow answer still arrives. Results name their hold; the reducer ignores answers about a hold it
 * no longer tracks. A failed check simply ends, and the next snapshot asks again. The returned
 * promise settles once the started request is handled (immediately when one was already running).
 */
export function createHoldCheck(fetchHold: (holdId: string) => Promise<Hold>, onResult: (result: HoldCheckResult) => void) {
  const inFlight = new Set<string>();
  return async function check(holdId: string): Promise<void> {
    if (inFlight.has(holdId)) return;
    inFlight.add(holdId);
    try {
      onResult({ type: "hold-status", hold: await fetchHold(holdId) });
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") onResult({ type: "hold-gone", holdId });
    } finally {
      inFlight.delete(holdId);
    }
  };
}
