"use client";

import type { DemoSessionResponse, PaymentAttempt, PaymentScenario } from "@seatrush/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createActionKeys, holdAction, releaseAction } from "../../lib/action-keys.js";
import { ApiError, createBookingApi } from "../../lib/booking-api.js";
import {
  bookingReducer,
  holdNeedsCheck,
  initialBookingState,
  type ConnectionProblem,
  type Failure,
} from "../../lib/booking-state.js";
import { clockOffsetMs } from "../../lib/countdown.js";
import {
  browserSessionStore,
  clearDemoSession,
  loadDemoSession,
  loadTrackedPayment,
  saveDemoSession,
  saveTrackedPayment,
} from "../../lib/demo-session.js";
import { createHoldCheck } from "../../lib/hold-check.js";
import { createPaymentTracker, type PaymentTracker } from "../../lib/payment-tracker.js";
import { POLL_RETRY_MS, payAction, paymentPhase, paymentRequest } from "../../lib/payment.js";

/** Snapshot re-fetch interval while the tab is visible. Interim until the event stream lands. */
export const SNAPSHOT_INTERVAL_MS = 2_000;

/**
 * Each demo session is a fresh identity and issuance is rate limited per IP, so after a failed
 * request for one the page waits this long before asking again, instead of on every poll.
 */
const SESSION_RETRY_MS = 15_000;

function toFailure(error: unknown): Failure {
  return error instanceof ApiError
    ? { code: error.code, seatIds: error.seatIds, requestId: error.requestId }
    : { code: "invalid_response" };
}

function connectionProblem(error: unknown): ConnectionProblem {
  if (!(error instanceof ApiError) || error.code === "network") return "unreachable";
  return error.code === "rate_limited" || error.code === "retry_later" ? "busy" : "failing";
}

/**
 * Drives the booking page: a demo session, the demo screening's snapshot every
 * {@link SNAPSHOT_INTERVAL_MS} while visible and right after each action, and hold/release calls.
 * All ownership shown comes from server answers applied by {@link bookingReducer}.
 */
export function useBooking(apiUrl: string) {
  const api = useMemo(() => createBookingApi(apiUrl), [apiUrl]);
  const [state, dispatch] = useReducer(bookingReducer, initialBookingState);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  /** The current identity, in memory first; sessionStorage only lets a reload keep it. */
  const session = useRef<Promise<DemoSessionResponse> | null>(null);
  /** The last failed issuance and when the page may ask again. */
  const sessionRetry = useRef<{ atMs: number; error: unknown } | null>(null);
  /** Set when a 401 led to a new session; cleared by the next authenticated success. */
  const renewed = useRef(false);
  const screeningId = useRef<Promise<string> | null>(null);
  const epoch = useRef(0);
  const refreshing = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  // Hold, release and pay keep separate keys so retrying one never retires another's.
  const holdKeys = useMemo(() => createActionKeys(), []);
  const releaseKeys = useMemo(() => createActionKeys(), []);
  const payKeys = useMemo(() => createActionKeys(), []);

  /** One demo identity per tab: reused from sessionStorage, otherwise issued once by the server. */
  const ensureSession = useCallback(async (): Promise<string> => {
    session.current ??= (async () => {
      const store = browserSessionStore();
      const stored = loadDemoSession(store, Date.now());
      if (stored) {
        dispatch({ type: "session", customerName: stored.customer.displayName });
        return stored;
      }
      const retry = sessionRetry.current;
      if (retry && Date.now() < retry.atMs) throw retry.error;
      let issued: DemoSessionResponse;
      try {
        issued = await api.createDemoSession();
      } catch (error) {
        sessionRetry.current = { atMs: Date.now() + SESSION_RETRY_MS, error };
        dispatch({
          type: "session-failed",
          reason: error instanceof ApiError && error.code === "rate_limited" ? "rate_limited" : "unavailable",
        });
        throw error;
      }
      sessionRetry.current = null;
      saveDemoSession(store, issued);
      dispatch({ type: "session", customerName: issued.customer.displayName });
      return issued;
    })().catch((error: unknown) => {
      session.current = null;
      throw error;
    });
    return (await session.current).token;
  }, [api]);

  /**
   * After a 401, replace the session once. Returns false when a renewal already happened with no
   * authenticated success since: another new identity would not fix a second 401 in a row.
   */
  const renewSession = useCallback(async (): Promise<boolean> => {
    if (renewed.current) return false;
    renewed.current = true;
    clearDemoSession(browserSessionStore());
    session.current = null;
    await ensureSession().catch(() => undefined);
    return true;
  }, [ensureSession]);

  const ensureScreening = useCallback((): Promise<string> => {
    screeningId.current ??= api.getDemoScreening().catch((error: unknown) => {
      screeningId.current = null;
      throw error;
    });
    return screeningId.current;
  }, [api]);

  const loadSnapshot = useCallback(async () => {
    try {
      // Without a session the seat map still loads anonymously; holding waits for one.
      const [token, screening] = await Promise.all([ensureSession().catch(() => undefined), ensureScreening()]);
      const requestEpoch = epoch.current;
      const { body, sentAtMs, receivedAtMs } = await api.getSnapshot(screening, token);
      if (token) renewed.current = false;
      dispatch({
        type: "snapshot",
        snapshot: body,
        epoch: requestEpoch,
        clockOffsetMs: clockOffsetMs(body.serverTime, sentAtMs, receivedAtMs),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized" && (await renewSession())) return;
      dispatch({ type: "connection-lost", reason: connectionProblem(error) });
    }
  }, [api, ensureScreening, ensureSession, renewSession]);

  /** Single-flight: a refresh requested mid-flight runs once more after the current one. */
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return refreshing.current;
    }
    refreshing.current = (async () => {
      do {
        refreshAgain.current = false;
        await loadSnapshot();
      } while (refreshAgain.current);
    })().finally(() => {
      refreshing.current = null;
    });
    return refreshing.current;
  }, [loadSnapshot]);

  // Poll while the tab is visible; catch up immediately when it becomes visible again.
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = window.setTimeout(tick, SNAPSHOT_INTERVAL_MS);
    };
    const tick = async () => {
      await refresh();
      schedule();
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  // The snapshot stopped listing the tracked hold: ask the server what became of it. Each newer
  // snapshot asks again, but a request already out for that hold is left to finish.
  const checkHold = useMemo(
    () => createHoldCheck(async (holdId) => api.getHold(holdId, await ensureSession()), dispatch),
    [api, ensureSession],
  );
  const checkHoldId = holdNeedsCheck(state) ? (state.hold?.id ?? null) : null;
  const snapshotTime = state.snapshot?.serverTime;
  useEffect(() => {
    if (checkHoldId) void checkHold(checkHoldId);
  }, [checkHold, checkHoldId, snapshotTime]);

  const toggleSeat = useCallback((seatId: string) => dispatch({ type: "toggle", seatId }), []);

  const holdSeats = useCallback(async () => {
    const { pending, selection } = stateRef.current;
    if (pending || selection.length === 0) return;
    dispatch({ type: "hold-start" });
    let action: string | undefined;
    try {
      const [token, screening] = await Promise.all([ensureSession(), ensureScreening()]);
      action = holdAction(screening, selection);
      const hold = await api.createHold(screening, selection, token, holdKeys.keyFor(action));
      holdKeys.settle(action);
      renewed.current = false;
      dispatch({ type: "hold-done", hold, epoch: ++epoch.current });
    } catch (error) {
      if (action) holdKeys.settle(action, error);
      const failure = toFailure(error);
      dispatch({ type: "hold-failed", failure, epoch: ++epoch.current });
      if (failure.code === "unauthorized") await renewSession();
    }
    await refresh();
  }, [api, ensureScreening, ensureSession, holdKeys, refresh, renewSession]);

  const releaseHold = useCallback(async () => {
    const { pending, hold } = stateRef.current;
    if (pending || !hold) return;
    dispatch({ type: "release-start" });
    const action = releaseAction(hold.id);
    try {
      const token = await ensureSession();
      const released = await api.releaseHold(hold.id, token, releaseKeys.keyFor(action));
      releaseKeys.settle(action);
      renewed.current = false;
      dispatch({ type: "release-done", hold: released, epoch: ++epoch.current });
    } catch (error) {
      releaseKeys.settle(action, error);
      const failure = toFailure(error);
      dispatch({ type: "release-failed", failure, epoch: ++epoch.current });
      if (failure.code === "unauthorized") await renewSession();
    }
    await refresh();
  }, [api, ensureSession, refresh, releaseKeys, renewSession]);

  /** Applies an attempt; a final one ends the hold, so earlier snapshots go stale and the map refreshes. */
  const applyAttempt = useCallback(
    (attempt: PaymentAttempt) => {
      const settled = paymentPhase(attempt).kind !== "waiting";
      dispatch({ type: "payment-status", attempt, epoch: settled ? ++epoch.current : 0 });
      if (settled) void refresh();
    },
    [refresh],
  );

  /** Follows payments outside React; see payment-tracker.ts. One per mount. */
  const tracker = useRef<PaymentTracker | null>(null);
  useEffect(() => {
    const store = browserSessionStore();
    const created = createPaymentTracker({
      getPayment: async (id) => api.getPayment(id, await ensureSession()),
      getHold: async (holdId) => api.getHold(holdId, await ensureSession()),
      onAttempt: applyAttempt,
      onGone: (paymentAttemptId) => dispatch({ type: "payment-gone", paymentAttemptId }),
      load: () => loadTrackedPayment(store),
      save: (ref) => saveTrackedPayment(store, ref),
      isVisible: () => document.visibilityState === "visible",
    });
    tracker.current = created;
    created.resume();
    const onVisibility = () => {
      if (document.visibilityState === "visible") created.visible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      created.stop();
      if (tracker.current === created) tracker.current = null;
    };
  }, [api, applyAttempt, ensureSession]);

  // The hold's latest attempt may be one this page never heard about (a start answer that was lost).
  const latestAttemptId = state.hold?.latestPaymentAttemptId ?? null;
  useEffect(() => {
    if (latestAttemptId) tracker.current?.consider(latestAttemptId);
  }, [latestAttemptId]);

  const pay = useCallback(
    async (scenario: PaymentScenario) => {
      const { pending, hold } = stateRef.current;
      if (pending || !hold) return;
      dispatch({ type: "pay-start" });
      const request = paymentRequest(scenario);
      const action = payAction(hold.id, request);
      // Recorded before sending, so a lost answer is recovered from the hold, even after a reload.
      tracker.current?.starting(hold.id);
      try {
        const token = await ensureSession();
        const attempt = await api.startPayment(hold.id, request, token, payKeys.keyFor(action));
        payKeys.settle(action);
        renewed.current = false;
        dispatch({ type: "pay-done", attempt });
        tracker.current?.started(attempt);
      } catch (error) {
        payKeys.settle(action, error);
        const failure = toFailure(error);
        dispatch({ type: "pay-failed", failure, epoch: ++epoch.current });
        if (failure.code === "unauthorized") await renewSession();
        // Lost answers, payment_in_progress and already_confirmed: the hold names the attempt it has.
        else tracker.current?.recoverHold(hold.id);
        await refresh();
      }
    },
    [api, ensureSession, payKeys, refresh, renewSession],
  );

  // A confirmed attempt names its booking: fetch the tickets, retrying until the box office answers.
  const bookingId =
    state.payment && !state.payment.booking && !state.payment.bookingUnavailable ? state.payment.attempt.bookingId : null;
  useEffect(() => {
    if (!bookingId) return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const booking = await api.getBooking(bookingId, await ensureSession());
        if (!stopped) dispatch({ type: "booking-loaded", booking });
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.code === "not_found") {
          dispatch({ type: "booking-unavailable", bookingId });
          return;
        }
        timer = window.setTimeout(load, POLL_RETRY_MS);
      }
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [api, bookingId, ensureSession]);

  const dismissPayment = useCallback(() => {
    tracker.current?.forget();
    dispatch({ type: "payment-dismissed" });
  }, []);

  return { state, toggleSeat, holdSeats, releaseHold, refresh, pay, dismissPayment };
}
