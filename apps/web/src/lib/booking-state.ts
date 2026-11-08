import type { Hold, ScreeningSnapshot } from "@seatrush/shared";
import type { FailureCode } from "./booking-api.js";
import {
  HOLD_ACTIVE_MESSAGE,
  SELECTION_LIMIT_MESSAGE,
  expiredMessage,
  heldMessage,
  holdFailureMessage,
  releaseFailureMessage,
  releasedMessage,
  takenFromSelectionMessage,
} from "./messages.js";
import { seatState, type SeatState } from "./seat-map.js";
import { reconcileSelection, toggleSeat } from "./selection.js";

/**
 * Client booking state. Seat ownership changes only by applying server answers (snapshots, hold
 * responses); the only local state is the unsent selection and what to tell the customer.
 */

export interface Notice {
  /** Increments per notice so a repeated message is announced again. */
  id: number;
  kind: "outcome" | "problem" | "expired";
  text: string;
}

export type ConnectionProblem = "unreachable" | "busy" | "failing";

export interface BookingState {
  customerName: string | null;
  /**
   * Why there is no demo session: "rate_limited" (this IP started too many in the last minute) or
   * "unavailable" (the request failed). Null while one is being fetched or once there is one.
   */
  sessionProblem: "rate_limited" | "unavailable" | null;
  snapshot: ScreeningSnapshot | null;
  /** Estimated server clock minus local clock, from the latest snapshot. */
  clockOffsetMs: number;
  /** Bumped after every hold or release answer; snapshots requested earlier are stale. */
  epoch: number;
  /** Seat ids in the order chosen. */
  selection: readonly string[];
  /** Seats the box office just refused because another customer owns them. */
  taken: readonly string[];
  /** The customer's active hold as last reported by the server. */
  hold: Hold | null;
  pending: "hold" | "release" | null;
  /**
   * Why the latest snapshot failed: "unreachable" (no answer), "busy" (429/503, slow down) or
   * "failing" (the API answered with an error).
   */
  connection: "connecting" | "ok" | ConnectionProblem;
  notice: Notice | null;
}

export interface Failure {
  code: FailureCode;
  seatIds?: readonly string[] | undefined;
  requestId?: string | undefined;
}

export type BookingAction =
  | { type: "session"; customerName: string }
  | { type: "session-failed"; reason: "rate_limited" | "unavailable" }
  | { type: "snapshot"; snapshot: ScreeningSnapshot; epoch: number; clockOffsetMs: number }
  | { type: "connection-lost"; reason: ConnectionProblem }
  | { type: "toggle"; seatId: string }
  | { type: "hold-start" }
  | { type: "hold-done"; hold: Hold; epoch: number }
  | { type: "hold-failed"; failure: Failure; epoch: number }
  | { type: "release-start" }
  | { type: "release-done"; hold: Hold; epoch: number }
  | { type: "release-failed"; failure: Failure; epoch: number }
  /** The server's answer to GET /holds/:id for the hold the client is tracking. */
  | { type: "hold-status"; hold: Hold }
  /** GET /holds/:id answered 404: the hold is not visible to this session any more. */
  | { type: "hold-gone"; holdId: string };

export const initialBookingState: BookingState = {
  customerName: null,
  sessionProblem: null,
  snapshot: null,
  clockOffsetMs: 0,
  epoch: 0,
  selection: [],
  taken: [],
  hold: null,
  pending: null,
  connection: "connecting",
  notice: null,
};

function notify(state: BookingState, kind: Notice["kind"], text: string): Notice {
  return { id: (state.notice?.id ?? 0) + 1, kind, text };
}

function labelsFor(snapshot: ScreeningSnapshot | null, ids: readonly string[]): string[] {
  const byId = new Map(snapshot?.seats.map((seat) => [seat.id, seat.label]));
  return ids.map((id) => byId.get(id) ?? "a seat");
}

function isNewer(next: ScreeningSnapshot, current: ScreeningSnapshot | null): boolean {
  if (!current) return true;
  const nextId = BigInt(next.lastEventId);
  const currentId = BigInt(current.lastEventId);
  // Same event id: expiry needs no event, so the later database clock is the fresher picture.
  return nextId > currentId || (nextId === currentId && Date.parse(next.serverTime) >= Date.parse(current.serverTime));
}

function applySnapshot(
  state: BookingState,
  { snapshot, epoch, clockOffsetMs }: Extract<BookingAction, { type: "snapshot" }>,
): BookingState {
  if (epoch < state.epoch || !isNewer(snapshot, state.snapshot)) return state;

  const stateById = new Map<string, SeatState>(snapshot.seats.map((seat) => [seat.id, seatState(seat)]));
  const yourHold = snapshot.yourHold?.status === "active" ? snapshot.yourHold : null;
  const { selection, takenByOthers } = yourHold
    ? { selection: [], takenByOthers: [] }
    : reconcileSelection(state.selection, stateById);
  const stillTaken = state.taken.filter((id) => {
    const seat = stateById.get(id);
    return seat === "held-by-other" || seat === "confirmed";
  });
  const taken = [...stillTaken, ...takenByOthers.filter((id) => !stillTaken.includes(id))];

  return {
    ...state,
    snapshot,
    clockOffsetMs,
    connection: "ok",
    selection,
    taken,
    // A snapshot without your hold does not end it here: the hook asks GET /holds/:id why.
    hold: yourHold ?? state.hold,
    notice:
      takenByOthers.length > 0
        ? notify(state, "problem", takenFromSelectionMessage(labelsFor(snapshot, takenByOthers)))
        : state.notice,
  };
}

function applyHoldStatus(state: BookingState, hold: Hold): BookingState {
  if (state.hold?.id !== hold.id) return state;
  const labels = hold.seats.map((seat) => seat.label);
  switch (hold.status) {
    case "active":
      return { ...state, hold };
    case "expired":
      return { ...state, hold: null, notice: notify(state, "expired", expiredMessage(labels)) };
    case "released":
      return { ...state, hold: null, notice: notify(state, "outcome", releasedMessage(labels)) };
    case "confirmed":
      return { ...state, hold: null };
  }
}

export function bookingReducer(state: BookingState, action: BookingAction): BookingState {
  switch (action.type) {
    case "session":
      return { ...state, customerName: action.customerName, sessionProblem: null };

    case "session-failed":
      return state.sessionProblem === action.reason ? state : { ...state, customerName: null, sessionProblem: action.reason };

    case "snapshot":
      return applySnapshot(state, action);

    case "connection-lost":
      return state.connection === action.reason ? state : { ...state, connection: action.reason };

    case "toggle": {
      const seat = state.snapshot?.seats.find((candidate) => candidate.id === action.seatId);
      if (!seat || state.pending) return state;
      const result = toggleSeat(
        state.selection,
        { id: seat.id, state: seatState(seat) },
        { holdActive: state.hold !== null },
      );
      switch (result.kind) {
        case "changed":
          return { ...state, selection: result.selection };
        case "limit":
          return { ...state, notice: notify(state, "problem", SELECTION_LIMIT_MESSAGE) };
        case "hold-active":
          return { ...state, notice: notify(state, "problem", HOLD_ACTIVE_MESSAGE) };
        case "unavailable":
          return state;
      }
    }

    case "hold-start":
      return { ...state, pending: "hold", taken: [] };

    case "hold-done":
      return {
        ...state,
        epoch: action.epoch,
        pending: null,
        hold: action.hold,
        selection: [],
        taken: [],
        notice: notify(
          state,
          "outcome",
          heldMessage(
            action.hold.seats.map((seat) => seat.label),
            action.hold.amountPaise,
          ),
        ),
      };

    case "hold-failed": {
      const { code, seatIds = [], requestId } = action.failure;
      const base = { ...state, epoch: action.epoch, pending: null };
      if (code === "seat_unavailable") {
        const taken = seatIds.filter((id) => state.selection.includes(id));
        return {
          ...base,
          selection: state.selection.filter((id) => !taken.includes(id)),
          taken,
          notice: notify(
            state,
            "problem",
            holdFailureMessage({ code, takenLabels: labelsFor(state.snapshot, taken), requestId }),
          ),
        };
      }
      return {
        ...base,
        selection: code === "invalid_seats" ? [] : state.selection,
        notice: notify(state, "problem", holdFailureMessage({ code, requestId })),
      };
    }

    case "release-start":
      return { ...state, pending: "release" };

    case "release-done":
      return {
        ...state,
        epoch: action.epoch,
        pending: null,
        hold: null,
        notice: notify(state, "outcome", releasedMessage(action.hold.seats.map((seat) => seat.label))),
      };

    case "release-failed":
      return {
        ...state,
        epoch: action.epoch,
        pending: null,
        notice: notify(state, "problem", releaseFailureMessage(action.failure)),
      };

    case "hold-status":
      return applyHoldStatus(state, action.hold);

    case "hold-gone":
      return state.hold?.id === action.holdId ? { ...state, hold: null } : state;
  }
}

/**
 * True when the tracked hold needs the server's word: a snapshot taken after the hold was created
 * no longer lists it. Snapshots from before the hold existed say nothing about it.
 */
export function holdNeedsCheck({ hold, snapshot }: Pick<BookingState, "hold" | "snapshot">): boolean {
  return (
    hold !== null &&
    snapshot !== null &&
    snapshot.yourHold?.id !== hold.id &&
    Date.parse(snapshot.serverTime) >= Date.parse(hold.createdAt)
  );
}
