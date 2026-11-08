import { SEAT_ROWS, SEATS_PER_ROW, type SeatSnapshot } from "@seatrush/shared";

/** FR-01 seat states as seen by the current customer. */
export type SeatState = "available" | "held-by-you" | "held-by-other" | "confirmed";

export const SEAT_STATE_LABELS: Record<SeatState, string> = {
  available: "Available",
  "held-by-you": "Held by you",
  "held-by-other": "Held by another customer",
  confirmed: "Confirmed",
};

/**
 * Local overlays on top of the server state. `selected` is the customer's own unsent choice;
 * `taken` marks a seat the box office just refused because someone else owns it.
 */
export type SeatMark = "selected" | "taken";

export interface SeatView {
  id: string;
  label: string;
  row: string;
  number: number;
  state: SeatState;
}

export interface HallRow {
  row: string;
  seats: readonly SeatView[];
}

/** Maps the public snapshot state plus the viewer flag onto the four FR-01 states. */
export function seatState(seat: Pick<SeatSnapshot, "state" | "heldByYou">): SeatState {
  switch (seat.state) {
    case "available":
      return "available";
    case "confirmed":
      return "confirmed";
    case "held":
      return seat.heldByYou ? "held-by-you" : "held-by-other";
  }
}

const ROW_ORDER = new Map<string, number>(SEAT_ROWS.map((row, index) => [row, index]));

/**
 * Lays the snapshot out as the hall: rows in screen-to-back order, seats left to right.
 * Unknown rows sort last so a malformed snapshot still renders every seat it sent.
 */
export function buildHall(seats: readonly SeatSnapshot[]): HallRow[] {
  const byRow = new Map<string, SeatView[]>();
  for (const seat of seats) {
    const view: SeatView = {
      id: seat.id,
      label: seat.label,
      row: seat.row,
      number: seat.number,
      state: seatState(seat),
    };
    const row = byRow.get(seat.row);
    if (row) row.push(view);
    else byRow.set(seat.row, [view]);
  }
  const rank = (row: string) => ROW_ORDER.get(row) ?? SEAT_ROWS.length;
  return [...byRow.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([row, rowSeats]) => ({ row, seats: rowSeats.sort((a, b) => a.number - b.number) }));
}

/** The hall has a centre aisle between seats 5 and 6. */
export const AISLE_AFTER = SEATS_PER_ROW / 2;

/** Accessible name for a seat button, e.g. "B7, held by another customer". */
export function seatAccessibleName(seat: Pick<SeatView, "label" | "state">, mark?: SeatMark): string {
  const state = SEAT_STATE_LABELS[seat.state].toLowerCase();
  return mark === "taken" ? `${seat.label}, ${state}, just taken` : `${seat.label}, ${state}`;
}
