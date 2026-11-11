import type { Hold, PaymentAttempt } from "@seatrush/shared";
import { ApiError } from "./booking-api.js";
import type { TrackedPaymentRef } from "./demo-session.js";
import { POLL_RETRY_MS, isStale, nextPollMs } from "./payment.js";

/** Waits between retries of a failed lookup: 1 s, 2 s, 4 s, 8 s, then every 15 s. */
export function backoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** failures, 15_000);
}

/** How many times a hold with no recorded attempt is asked again while it is still active. */
const EMPTY_HOLD_RETRIES = 4;

export interface PaymentTrackerDeps {
  getPayment(paymentAttemptId: string): Promise<PaymentAttempt>;
  /** Owner only; carries `latestPaymentAttemptId`, which survives a lost start answer. */
  getHold(holdId: string): Promise<Hold>;
  /** Every accepted answer about the followed attempt, in order, never older than the last. */
  onAttempt(attempt: PaymentAttempt): void;
  /** The followed attempt is not visible to this session (404). */
  onGone(paymentAttemptId: string): void;
  load(): TrackedPaymentRef | null;
  save(ref: TrackedPaymentRef | null): void;
  isVisible(): boolean;
}

export interface PaymentTracker {
  /** Picks up what this tab followed before a reload. */
  resume(): void;
  /** Call before sending POST /holds/:id/payments, so a lost answer can still be recovered. */
  starting(holdId: string): void;
  /** The start request answered with this attempt. */
  started(attempt: PaymentAttempt): void;
  /** The start request failed or its answer was lost: ask the hold which attempt it has. */
  recoverHold(holdId: string): void;
  /** An attempt id the server reported (the hold's latest); followed if it is newer. */
  consider(paymentAttemptId: string): void;
  /** The tab became visible: run whatever waited while it was hidden. */
  visible(): void;
  /** The customer closed the result: stop following the attempt. */
  forget(): void;
  stop(): void;
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.code === "not_found";

/**
 * Follows one payment attempt to its final answer (prd FR-04, FR-05) outside React, so the races
 * are testable: lost start answers, older attempts, transient failures, hidden tabs.
 *
 * - The followed attempt only moves forward: a slower, older answer about it is ignored, and an
 *   attempt created before the followed one never replaces it.
 * - One status request at a time; while the provider has not answered it asks every second, during
 *   a refund every two, and stops once the answer is final.
 * - Lookups (an attempt by id, a hold's latest attempt) retry with backoff until they succeed or
 *   the server says 404.
 * - Nothing runs while the tab is hidden; it all runs at once when the tab is visible again.
 */
export function createPaymentTracker(deps: PaymentTrackerDeps): PaymentTracker {
  let current: PaymentAttempt | null = null;
  let stopped = false;
  let pollScheduled = false;
  let pollInFlight = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const deferred: Array<() => void> = [];
  /** Lookups running or waiting to retry, so a repeated request does not start a second one. */
  const lookups = new Set<string>();
  /** Attempts the customer dismissed; late answers about them are dropped. */
  const dismissed = new Set<string>();

  function later(run: () => void, delayMs: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      if (deps.isVisible()) run();
      else deferred.push(run);
    }, delayMs);
    timers.add(timer);
  }

  function adopt(attempt: PaymentAttempt) {
    if (stopped || dismissed.has(attempt.id)) return;
    if (current) {
      const older =
        current.id === attempt.id
          ? isStale(attempt, current)
          : Date.parse(attempt.createdAt) < Date.parse(current.createdAt);
      if (older) return;
    }
    current = attempt;
    deps.save({ holdId: attempt.holdId, attemptId: attempt.id });
    deps.onAttempt(attempt);
    ensurePolling();
  }

  function ensurePolling() {
    if (!current || pollScheduled || pollInFlight) return;
    const delay = nextPollMs(current);
    if (delay === null) return;
    pollScheduled = true;
    later(pollOnce, delay);
  }

  async function pollOnce() {
    pollScheduled = false;
    const id = current?.id;
    if (!id) return;
    pollInFlight = true;
    let retry = false;
    try {
      adopt(await deps.getPayment(id));
    } catch (error) {
      if (isNotFound(error)) {
        if (current?.id === id) {
          current = null;
          deps.save(null);
          deps.onGone(id);
        }
      } else {
        retry = true;
      }
    } finally {
      pollInFlight = false;
    }
    if (stopped) return;
    if (retry) {
      pollScheduled = true;
      later(pollOnce, POLL_RETRY_MS);
    } else {
      ensurePolling();
    }
  }

  function lookUpAttempt(id: string, failures = 0) {
    const key = `attempt:${id}`;
    if (failures === 0 && lookups.has(key)) return;
    lookups.add(key);
    deps.getPayment(id).then(
      (attempt) => {
        lookups.delete(key);
        adopt(attempt);
      },
      (error: unknown) => {
        if (isNotFound(error)) {
          lookups.delete(key);
          if (deps.load()?.attemptId === id) deps.save(null);
          return;
        }
        later(() => lookUpAttempt(id, failures + 1), backoffMs(failures));
      },
    );
  }

  function lookUpHold(holdId: string, failures = 0, empties = 0) {
    const key = `hold:${holdId}`;
    if (failures === 0 && empties === 0 && lookups.has(key)) return;
    lookups.add(key);
    const forgetPending = () => {
      const ref = deps.load();
      if (ref?.holdId === holdId && ref.attemptId === null) deps.save(null);
    };
    deps.getHold(holdId).then(
      (hold) => {
        if (hold.latestPaymentAttemptId) {
          lookups.delete(key);
          tracker.consider(hold.latestPaymentAttemptId);
        } else if (hold.status === "active" && empties < EMPTY_HOLD_RETRIES) {
          // The start request may still be committing: ask again shortly.
          later(() => lookUpHold(holdId, 0, empties + 1), backoffMs(empties));
        } else {
          lookups.delete(key);
          forgetPending();
        }
      },
      (error: unknown) => {
        if (isNotFound(error)) {
          lookups.delete(key);
          forgetPending();
          return;
        }
        later(() => lookUpHold(holdId, failures + 1, empties), backoffMs(failures));
      },
    );
  }

  const tracker: PaymentTracker = {
    resume() {
      const ref = deps.load();
      if (!ref) return;
      if (ref.attemptId) lookUpAttempt(ref.attemptId);
      else lookUpHold(ref.holdId);
    },
    starting(holdId) {
      deps.save({ holdId, attemptId: null });
    },
    started: adopt,
    recoverHold: (holdId) => lookUpHold(holdId),
    consider(id) {
      if (current?.id === id || dismissed.has(id)) return;
      lookUpAttempt(id);
    },
    visible() {
      for (const run of deferred.splice(0)) if (!stopped) run();
    },
    forget() {
      if (current) dismissed.add(current.id);
      current = null;
      deps.save(null);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      deferred.length = 0;
    },
  };
  return tracker;
}
