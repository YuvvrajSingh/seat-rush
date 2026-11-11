import { describe, expect, it } from "vitest";
import {
  bookingReducer,
  holdNeedsCheck,
  initialBookingState,
  panelView,
  type BookingAction,
  type BookingState,
} from "../src/lib/booking-state.js";
import { ATTEMPT_ID, BOOKING_ID, makeAttempt, makeBooking, makeHold, makeSnapshot, seatId } from "./fixtures.js";

function run(...actions: BookingAction[]): BookingState {
  return actions.reduce(bookingReducer, initialBookingState);
}

const snapshot = (options: Parameters<typeof makeSnapshot>[0] = {}, epoch = 0): BookingAction => ({
  type: "snapshot",
  snapshot: makeSnapshot(options),
  epoch,
  clockOffsetMs: 0,
});
const toggle = (label: string): BookingAction => ({ type: "toggle", seatId: seatId(label) });

describe("demo session", () => {
  it("records why there is no session and clears it once one arrives", () => {
    const limited = run({ type: "session-failed", reason: "rate_limited" });
    expect(limited).toMatchObject({ customerName: null, sessionProblem: "rate_limited" });
    const started = bookingReducer(limited, { type: "session", customerName: "Demo Customer 7" });
    expect(started).toMatchObject({ customerName: "Demo Customer 7", sessionProblem: null });
  });

  it("still shows the seat map while there is no session", () => {
    const state = run({ type: "session-failed", reason: "rate_limited" }, snapshot());
    expect(state.snapshot).not.toBeNull();
    expect(state.connection).toBe("ok");
  });
});

describe("selection", () => {
  it("chooses available seats and refuses a fifth", () => {
    const state = run(snapshot(), toggle("A1"), toggle("A2"), toggle("A3"), toggle("A4"), toggle("A5"));
    expect(state.selection).toEqual(["A1", "A2", "A3", "A4"].map(seatId));
    expect(state.notice).toMatchObject({ kind: "problem", text: expect.stringContaining("up to 4 seats") });
  });

  it("ignores presses on seats someone else holds", () => {
    const state = run(snapshot({ seats: { B7: { state: "held" } } }), toggle("B7"));
    expect(state.selection).toEqual([]);
  });

  it("ignores presses while a hold request is in flight", () => {
    const state = run(snapshot(), toggle("A1"), { type: "hold-start" }, toggle("A2"));
    expect(state.selection).toEqual([seatId("A1")]);
  });

  it("refuses new choices while a hold is active and says why", () => {
    const hold = makeHold(["A1"]);
    const state = run(snapshot(), { type: "hold-done", hold, epoch: 1 }, toggle("A2"));
    expect(state.selection).toEqual([]);
    expect(state.notice?.text).toMatch(/Release your held seats/);
  });

  it("drops seats another customer took in the meantime and marks them taken", () => {
    const state = run(
      snapshot(),
      toggle("B7"),
      toggle("B8"),
      snapshot({ seats: { B7: { state: "held" } }, lastEventId: "2" }),
    );
    expect(state.selection).toEqual([seatId("B8")]);
    expect(state.taken).toEqual([seatId("B7")]);
    expect(state.notice?.text).toBe("B7 was just taken by another customer and left your selection.");
  });
});

describe("holding", () => {
  it("shows the server's hold and price, and clears the selection", () => {
    const hold = makeHold(["B7", "B8"], { amountPaise: 40_000 });
    const state = run(snapshot(), toggle("B7"), toggle("B8"), { type: "hold-start" }, { type: "hold-done", hold, epoch: 1 });
    expect(state.hold).toBe(hold);
    expect(state.selection).toEqual([]);
    expect(state.pending).toBeNull();
    expect(state.notice).toMatchObject({ kind: "outcome", text: "B7 and B8 are held for you. Total ₹400." });
  });

  it("on seat_unavailable marks the named seats and keeps the rest of the selection", () => {
    const state = run(snapshot(), toggle("B7"), toggle("B8"), toggle("B9"), { type: "hold-start" }, {
      type: "hold-failed",
      failure: { code: "seat_unavailable", seatIds: [seatId("B8")] },
      epoch: 1,
    });
    expect(state.selection).toEqual([seatId("B7"), seatId("B9")]);
    expect(state.taken).toEqual([seatId("B8")]);
    expect(state.hold).toBeNull();
    expect(state.notice?.text).toMatch(/^B8 was just taken by another customer, so nothing was held/);
  });

  it("on seat_unavailable without seat ids, finds the taken seats in the refreshed snapshot", () => {
    const state = run(
      snapshot(),
      toggle("B7"),
      toggle("B8"),
      { type: "hold-start" },
      { type: "hold-failed", failure: { code: "seat_unavailable" }, epoch: 1 },
      snapshot({ seats: { B8: { state: "held" } }, lastEventId: "2" }, 1),
    );
    expect(state.selection).toEqual([seatId("B7")]);
    expect(state.taken).toEqual([seatId("B8")]);
  });

  it("keeps the selection on a transient failure so the customer can retry", () => {
    const state = run(snapshot(), toggle("B7"), { type: "hold-start" }, {
      type: "hold-failed",
      failure: { code: "retry_later" },
      epoch: 1,
    });
    expect(state.selection).toEqual([seatId("B7")]);
    expect(state.notice?.text).toMatch(/nothing was held/);
  });

  it("on active_hold_exists shows the existing hold once the snapshot reports it", () => {
    const existing = makeHold(["J1", "J2"]);
    const state = run(
      snapshot(),
      toggle("B7"),
      { type: "hold-start" },
      { type: "hold-failed", failure: { code: "active_hold_exists" }, epoch: 1 },
      snapshot(
        { seats: { J1: { state: "held", heldByYou: true }, J2: { state: "held", heldByYou: true } }, yourHold: existing, lastEventId: "2" },
        1,
      ),
    );
    expect(state.hold).toEqual(existing);
    expect(state.selection).toEqual([]);
  });

  it("drops a snapshot requested before the hold answer arrived", () => {
    const hold = makeHold(["B7"], { createdAt: "2026-11-07T10:00:01.000Z" });
    const stale = snapshot({ seats: { B9: { state: "held" } }, lastEventId: "3" }, 0);
    const state = run(snapshot(), toggle("B7"), { type: "hold-done", hold, epoch: 1 }, stale);
    expect(state.snapshot?.lastEventId).toBe("1");
    expect(state.hold).toBe(hold);
    // The snapshot on screen predates the hold, so its silence about the hold means nothing.
    expect(holdNeedsCheck(state)).toBe(false);
  });

  it("drops a snapshot older than the one on screen", () => {
    const state = run(
      snapshot({ seats: { C1: { state: "held" } }, lastEventId: "5" }),
      snapshot({ lastEventId: "4", serverTime: "2026-11-07T10:00:05.000Z" }),
    );
    expect(state.snapshot?.lastEventId).toBe("5");
  });

  it("accepts a later snapshot with the same event id, since expiry needs no event", () => {
    const state = run(
      snapshot({ seats: { C1: { state: "held" } }, lastEventId: "5" }),
      snapshot({ lastEventId: "5", serverTime: "2026-11-07T10:05:01.000Z" }),
    );
    expect(state.snapshot?.seats.find((seat) => seat.label === "C1")?.state).toBe("available");
  });
});

describe("hold ending", () => {
  const hold = makeHold(["B7", "B8"]);
  const held = { B7: { state: "held", heldByYou: true }, B8: { state: "held", heldByYou: true } } as const;
  const holding = [
    snapshot({ seats: held, yourHold: hold, lastEventId: "2" }),
  ] as const;

  it("does not end the hold when a snapshot stops listing it; it asks the server first", () => {
    const state = run(...holding, snapshot({ lastEventId: "2", serverTime: "2026-11-07T10:05:01.000Z" }));
    expect(state.hold).toEqual(hold);
    expect(holdNeedsCheck(state)).toBe(true);
  });

  it("shows the expiry message only when the server says the hold expired", () => {
    const state = run(...holding, { type: "hold-status", hold: { ...hold, status: "expired" } });
    expect(state.hold).toBeNull();
    expect(state.notice).toMatchObject({
      kind: "expired",
      text: "Your hold on B7 and B8 ran out of time. Check the seat map to see what you can choose now.",
    });
  });

  it("keeps counting when the server says the hold is still active", () => {
    const state = run(...holding, { type: "hold-status", hold });
    expect(state.hold).toEqual(hold);
    expect(state.notice).toBeNull();
  });

  it("ignores status answers about a different hold", () => {
    const state = run(...holding, { type: "hold-status", hold: { ...hold, id: "22222222-2222-4222-8222-222222222222", status: "expired" } });
    expect(state.hold).toEqual(hold);
  });

  it("releases on the server's answer", () => {
    const state = run(...holding, { type: "release-start" }, { type: "release-done", hold: { ...hold, status: "released" }, epoch: 1 });
    expect(state.hold).toBeNull();
    expect(state.notice?.text).toBe("Released B7 and B8. You no longer hold them.");
  });

  it("keeps the hold when release fails", () => {
    const state = run(...holding, { type: "release-start" }, {
      type: "release-failed",
      failure: { code: "internal_error", requestId: "req-1" },
      epoch: 1,
    });
    expect(state.hold).toEqual(hold);
    expect(state.pending).toBeNull();
    expect(state.notice?.text).toMatch(/Reference req-1/);
  });
});

it("gives each notice a new id so the same message is announced again", () => {
  const state = run(snapshot(), toggle("A1"), toggle("A2"), toggle("A3"), toggle("A4"), toggle("A5"));
  const again = bookingReducer(state, toggle("A6"));
  expect(again.notice?.text).toBe(state.notice?.text);
  expect(again.notice?.id).toBe((state.notice?.id ?? 0) + 1);
});

describe("payments", () => {
  const hold = makeHold(["B7", "B8"]);
  const held: BookingAction[] = [snapshot(), { type: "hold-done", hold, epoch: 1 }];
  const started: BookingAction[] = [...held, { type: "pay-start" }, { type: "pay-done", attempt: makeAttempt() }];
  const status = (overrides: Parameters<typeof makeAttempt>[0], epoch = 0): BookingAction => ({
    type: "payment-status",
    attempt: makeAttempt(overrides),
    epoch,
  });

  it("waits for the provider with the hold still shown and says the payment was sent", () => {
    const state = run(...started);
    expect(state.pending).toBeNull();
    expect(panelView(state)).toMatchObject({ kind: "hold", hold: { id: hold.id }, attempt: { status: "initiated" } });
    expect(state.notice?.text).toContain("₹400");
  });

  it("keeps the hold after a decline so the customer can try again", () => {
    const state = run(...started, status({ status: "failed" }));
    expect(state.hold?.id).toBe(hold.id);
    expect(panelView(state)).toMatchObject({ kind: "hold", attempt: { status: "failed" } });
    expect(state.notice).toMatchObject({ kind: "announce" });
    expect(state.notice?.text).toContain("still held");
  });

  it("announces each phase once, not on every repeated poll", () => {
    const declined = run(...started, status({ status: "failed" }));
    expect(bookingReducer(declined, status({ status: "failed" })).notice?.id).toBe(declined.notice?.id);
  });

  it("shows the booking once confirmed, ends the hold and ignores snapshots requested before", () => {
    const booked = run(...started, status({ status: "succeeded", bookingId: BOOKING_ID }, 2));
    expect(booked.hold).toBeNull();
    expect(panelView(booked)).toMatchObject({ kind: "booked", bookingId: BOOKING_ID });
    expect(booked.notice?.text).toBe("Payment approved. B7 and B8 are booked for you.");

    const stale = bookingReducer(booked, snapshot({ yourHold: hold, lastEventId: "9" }, 1));
    expect(stale.hold).toBeNull();

    const loaded = bookingReducer(booked, { type: "booking-loaded", booking: makeBooking(["B7", "B8"]) });
    expect(loaded.payment?.booking?.reference).toBe("SR-7KQ2XM");
    const other = bookingReducer(booked, {
      type: "booking-loaded",
      booking: makeBooking(["C1"], { id: "88888888-8888-4888-8888-888888888888" }),
    });
    expect(other.payment?.booking).toBeNull();
  });

  it("never steps back to waiting on a slow, older answer", () => {
    const booked = run(...started, status({ status: "succeeded", bookingId: BOOKING_ID }, 2));
    expect(bookingReducer(booked, status({})).payment).toBe(booked.payment);
  });

  it("keeps the booking on screen until dismissed; seat presses meanwhile explain how to go on", () => {
    const booked = run(...started, status({ status: "succeeded", bookingId: BOOKING_ID }, 2));
    const pressed = bookingReducer(booked, toggle("A1"));
    expect(pressed.selection).toEqual([]);
    expect(pressed.notice?.text).toContain("Choose seats again");
    expect(panelView(bookingReducer(booked, { type: "payment-dismissed" }))).toEqual({ kind: "selection" });
  });

  it("explains a hold that runs out while the provider has the payment, then the refund", () => {
    const expired = run(...started, { type: "hold-status", hold: { ...hold, status: "expired" } });
    expect(expired.hold).toBeNull();
    expect(panelView(expired)).toMatchObject({ kind: "paying-after-hold" });
    expect(expired.notice).toMatchObject({ kind: "expired" });
    expect(expired.notice?.text).toContain("refunded");
    expect(expired.notice?.text).not.toMatch(/available/i);

    const refunding = bookingReducer(
      expired,
      status({ status: "succeeded", refund: { status: "required", amountPaise: 40_000, reason: "hold_expired" } }, 2),
    );
    expect(panelView(refunding)).toMatchObject({ kind: "refund" });
    expect(refunding.notice?.text).toContain("not booked");
    expect(refunding.notice?.text).toContain("₹400");
  });

  it("says a release during payment means a late approval is refunded", () => {
    const state = run(...started, { type: "release-start" }, { type: "release-done", hold: { ...hold, status: "released" }, epoch: 2 });
    expect(state.notice?.text).toContain("refunded");
    expect(panelView(state)).toMatchObject({ kind: "paying-after-hold" });
  });

  it("explains a refused start and keeps the hold", () => {
    const state = run(...held, { type: "pay-start" }, { type: "pay-failed", failure: { code: "payment_in_progress" }, epoch: 2 });
    expect(state.pending).toBeNull();
    expect(state.hold?.id).toBe(hold.id);
    expect(state.notice?.text).toContain("already with the provider");
  });

  it("forgets an attempt the server no longer shows this session", () => {
    const state = run(...started, { type: "payment-gone", paymentAttemptId: ATTEMPT_ID });
    expect(state.payment).toBeNull();
  });
});

describe("payment races", () => {
  const hold = makeHold(["B7", "B8"]);
  const held: BookingAction[] = [snapshot(), { type: "hold-done", hold, epoch: 1 }, { type: "pay-start" }];

  it("does not announce a start when a slow start answer arrives after the recovered booking", () => {
    const booked = run(...held, {
      type: "payment-status",
      attempt: makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }),
      epoch: 2,
    });
    const late = bookingReducer(booked, { type: "pay-done", attempt: makeAttempt() });
    expect(late.pending).toBeNull();
    expect(late.notice).toBe(booked.notice);
    expect(panelView(late)).toMatchObject({ kind: "booked" });
  });

  it("lets a newer attempt replace an older decline, never the reverse", () => {
    const older = makeAttempt({ id: "99999999-9999-4999-8999-999999999999", status: "failed", createdAt: "2026-11-07T10:00:30.000Z" });
    const declined = run(...held, { type: "pay-done", attempt: older });
    const newer = bookingReducer(declined, { type: "payment-status", attempt: makeAttempt(), epoch: 0 });
    expect(newer.payment?.attempt.id).toBe(ATTEMPT_ID);
    const back = bookingReducer(newer, { type: "payment-status", attempt: older, epoch: 0 });
    expect(back.payment?.attempt.id).toBe(ATTEMPT_ID);
  });

  it("ends the ticket spinner when the booking cannot be fetched", () => {
    const booked = run(...held, {
      type: "payment-status",
      attempt: makeAttempt({ status: "succeeded", bookingId: BOOKING_ID }),
      epoch: 2,
    });
    const state = bookingReducer(booked, { type: "booking-unavailable", bookingId: BOOKING_ID });
    expect(state.payment).toMatchObject({ booking: null, bookingUnavailable: true });
  });
});
