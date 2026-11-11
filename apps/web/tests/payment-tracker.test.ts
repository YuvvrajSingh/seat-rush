import type { Hold, PaymentAttempt } from "@seatrush/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/booking-api.js";
import type { TrackedPaymentRef } from "../src/lib/demo-session.js";
import { PAYMENT_POLL_MS } from "../src/lib/payment.js";
import { backoffMs, createPaymentTracker } from "../src/lib/payment-tracker.js";
import { ATTEMPT_ID, BOOKING_ID, makeAttempt, makeHold } from "./fixtures.js";

const HOLD_ID = "11111111-1111-4111-8111-111111111111";
const OLDER_ID = "99999999-9999-4999-8999-999999999999";

type Deferred<T> = PromiseWithResolvers<T>;
const deferred = <T,>(): Deferred<T> => Promise.withResolvers<T>();

/** A tracker whose every server request waits for the test to answer it. */
function setup({ stored = null as TrackedPaymentRef | null, visible = true } = {}) {
  const payments: Array<{ id: string; answer: Deferred<PaymentAttempt> }> = [];
  const holds: Array<{ holdId: string; answer: Deferred<Hold> }> = [];
  const seen: PaymentAttempt[] = [];
  const gone: string[] = [];
  const env = { ref: stored, visible };
  const tracker = createPaymentTracker({
    getPayment: (id) => {
      const answer = deferred<PaymentAttempt>();
      payments.push({ id, answer });
      return answer.promise;
    },
    getHold: (holdId) => {
      const answer = deferred<Hold>();
      holds.push({ holdId, answer });
      return answer.promise;
    },
    onAttempt: (attempt) => seen.push(attempt),
    onGone: (id) => gone.push(id),
    load: () => env.ref,
    save: (ref) => {
      env.ref = ref;
    },
    isVisible: () => env.visible,
  });
  return { tracker, payments, holds, seen, gone, env };
}

const lost = () => new ApiError("network", "lost");
const notFound = () => new ApiError("not_found", "gone", 404);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("payment tracker", () => {
  it("records the hold before the start request, so a lost answer is recovered from the hold", async () => {
    const { tracker, payments, holds, seen, env } = setup();
    tracker.starting(HOLD_ID);
    expect(env.ref).toEqual({ holdId: HOLD_ID, attemptId: null });

    // The POST's answer never arrives; the page asks the hold instead.
    tracker.recoverHold(HOLD_ID);
    holds[0]?.answer.resolve(makeHold(["B7", "B8"], { status: "confirmed", latestPaymentAttemptId: ATTEMPT_ID }));
    await flush();
    expect(payments[0]?.id).toBe(ATTEMPT_ID);
    payments[0]?.answer.resolve(makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }));
    await flush();

    expect(seen.at(-1)?.bookingId).toBe(BOOKING_ID);
    expect(env.ref).toEqual({ holdId: HOLD_ID, attemptId: ATTEMPT_ID });
  });

  it("recovers the same way after a reload with only the pending hold stored", async () => {
    const { tracker, holds } = setup({ stored: { holdId: HOLD_ID, attemptId: null } });
    tracker.resume();
    expect(holds.map((hold) => hold.holdId)).toEqual([HOLD_ID]);
  });

  it("forgets a pending start the hold never recorded once the hold is over", async () => {
    const { tracker, holds, payments, env } = setup({ stored: { holdId: HOLD_ID, attemptId: null } });
    tracker.resume();
    holds[0]?.answer.resolve(makeHold(["B7"], { status: "expired", latestPaymentAttemptId: null }));
    await flush();
    expect(payments).toHaveLength(0);
    expect(env.ref).toBeNull();
  });

  it("follows a newer attempt while an older decline is tracked, and never goes back to the older one", async () => {
    const { tracker, payments, seen } = setup();
    tracker.started(makeAttempt({ id: OLDER_ID, status: "failed", createdAt: "2026-11-07T10:00:30.000Z" }));
    tracker.consider(ATTEMPT_ID);
    payments[0]?.answer.resolve(makeAttempt({ createdAt: "2026-11-07T10:01:00.000Z" }));
    await flush();
    expect(seen.at(-1)?.id).toBe(ATTEMPT_ID);

    // A stale lookup of the older attempt answers late: ignored.
    tracker.consider(OLDER_ID);
    const older = payments.find((request) => request.id === OLDER_ID);
    older?.answer.resolve(makeAttempt({ id: OLDER_ID, status: "failed", createdAt: "2026-11-07T10:00:30.000Z" }));
    await flush();
    expect(seen.at(-1)?.id).toBe(ATTEMPT_ID);
  });

  it("retries a failed lookup with backoff until it succeeds", async () => {
    const { tracker, payments, seen } = setup({ stored: { holdId: HOLD_ID, attemptId: ATTEMPT_ID } });
    tracker.resume();
    payments[0]?.answer.reject(lost());
    await flush();
    expect(payments).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(backoffMs(0));
    expect(payments).toHaveLength(2);
    payments[1]?.answer.resolve(makeAttempt({ status: "failed" }));
    await flush();
    expect(seen.map((attempt) => attempt.status)).toEqual(["failed"]);
  });

  it("stops a lookup on 404 and forgets the stored attempt", async () => {
    const { tracker, payments, env } = setup({ stored: { holdId: HOLD_ID, attemptId: ATTEMPT_ID } });
    tracker.resume();
    payments[0]?.answer.reject(notFound());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(payments).toHaveLength(1);
    expect(env.ref).toBeNull();
  });

  it("ignores a slow start answer that arrives after the recovered booking", async () => {
    const { tracker, seen } = setup();
    tracker.started(makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }));
    tracker.started(makeAttempt());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bookingId).toBe(BOOKING_ID);
  });

  it("polls once a second while waiting, one request at a time, and stops on the final answer", async () => {
    const { tracker, payments, seen } = setup();
    tracker.started(makeAttempt());
    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS);
    expect(payments).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * PAYMENT_POLL_MS);
    expect(payments).toHaveLength(1); // still waiting for the first answer
    payments[0]?.answer.resolve(makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }));
    await flush();
    await vi.advanceTimersByTimeAsync(10 * PAYMENT_POLL_MS);
    expect(payments).toHaveLength(1);
    expect(seen.at(-1)?.bookingId).toBe(BOOKING_ID);
  });

  it("asks nothing while the tab is hidden and catches up as soon as it is visible", async () => {
    const { tracker, payments, env } = setup({ visible: false });
    tracker.started(makeAttempt());
    await vi.advanceTimersByTimeAsync(30 * PAYMENT_POLL_MS);
    expect(payments).toHaveLength(0);
    env.visible = true;
    tracker.visible();
    expect(payments).toHaveLength(1);
  });

  it("drops answers about a dismissed attempt and stops when stopped", async () => {
    const { tracker, payments, seen, env } = setup();
    tracker.started(makeAttempt());
    await vi.advanceTimersByTimeAsync(PAYMENT_POLL_MS);
    tracker.forget();
    expect(env.ref).toBeNull();
    payments[0]?.answer.resolve(makeAttempt({ status: "failed" }));
    await flush();
    expect(seen).toHaveLength(1);

    tracker.started(makeAttempt({ id: OLDER_ID }));
    tracker.stop();
    await vi.advanceTimersByTimeAsync(10 * PAYMENT_POLL_MS);
    expect(payments).toHaveLength(1);
  });
});
