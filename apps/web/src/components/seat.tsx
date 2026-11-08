import type { ReactNode } from "react";
import type { SeatMark, SeatState } from "../lib/seat-map.js";

const STATE_CLASSES: Record<SeatState, string> = {
  available: "border-(--seat-available) text-(--seat-available-ink)",
  "held-by-you": "border-(--seat-mine) bg-(--seat-mine) text-(--seat-mine-ink)",
  "held-by-other": "seat-hatch border-(--seat-held) text-(--seat-held-ink)",
  confirmed: "border-(--seat-confirmed) bg-(--seat-confirmed) text-(--seat-confirmed-ink)",
};

/** Selection stays an outline, never a fill, so it cannot be mistaken for a hold. */
const MARK_CLASSES: Record<SeatMark, string> = {
  selected: "seat-selected",
  taken: "seat-taken",
};

const SEAT_BASE =
  "grid size-seat shrink-0 place-items-center rounded-seat border-[1.5px] font-display text-xs font-bold tabular-nums min-[360px]:text-sm sm:text-base";

/** Class list for anything drawn as a seat, a static span or an interactive button. */
export function seatClassName(state: SeatState, mark?: SeatMark): string {
  return mark ? `${SEAT_BASE} ${STATE_CLASSES[state]} ${MARK_CLASSES[mark]}` : `${SEAT_BASE} ${STATE_CLASSES[state]}`;
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-[62%]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Non-colour cue for every state other than available, which shows its seat number instead. */
const STATE_GLYPHS: Record<Exclude<SeatState, "available">, ReactNode> = {
  "held-by-you": (
    <Glyph>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </Glyph>
  ),
  "held-by-other": (
    <Glyph>
      <path d="M4 2h8M4 14h8M5 2c0 3.5 6 3.5 6 6s-6 2.5-6 6M11 2c0 3.5-6 3.5-6 6s6 2.5 6 6" />
    </Glyph>
  ),
  confirmed: (
    <Glyph>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Glyph>
  ),
};

/** What a seat shows inside its outline: the seat number when available, a glyph otherwise. */
export function SeatFace({ state, number }: { state: SeatState; number?: number | undefined }) {
  return state === "available" ? number : STATE_GLYPHS[state];
}

/**
 * A single seat, drawn with a backrest-shaped top edge. Purely presentational:
 * callers supply accessible names where the seat is meaningful on its own.
 */
export function Seat({ state, number, mark }: { state: SeatState; number?: number; mark?: SeatMark }) {
  return (
    <span className={seatClassName(state, mark)}>
      <SeatFace state={state} number={number} />
    </span>
  );
}
