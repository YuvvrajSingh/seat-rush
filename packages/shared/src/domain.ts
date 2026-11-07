// Fixed MVP parameters (prd.md §5, §6). Single source for API, worker, seed, simulator and UI.

export const SEAT_ROWS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;
export type SeatRow = (typeof SEAT_ROWS)[number];

export const SEATS_PER_ROW = 10;
export const TOTAL_SEATS = SEAT_ROWS.length * SEATS_PER_ROW;

/** ₹200 per seat, stored as integer paise. */
export const SEAT_PRICE_PAISE = 20_000;

export const MIN_SEATS_PER_HOLD = 1;
export const MAX_SEATS_PER_HOLD = 4;

export const HOLD_TTL_SECONDS = 5 * 60;
export const SCREENING_DURATION_MINUTES = 3 * 60;

/** Seat label such as "A7": row letter + 1-based seat number. */
export function seatLabel(row: SeatRow, number: number): string {
  return `${row}${number}`;
}

export const ALL_SEAT_LABELS: readonly string[] = SEAT_ROWS.flatMap((row) =>
  Array.from({ length: SEATS_PER_ROW }, (_, i) => seatLabel(row, i + 1)),
);
