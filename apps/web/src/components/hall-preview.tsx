import { ALL_SEAT_LABELS, SEAT_ROWS, SEATS_PER_ROW, TOTAL_SEATS } from "@seatrush/shared";
import type { CSSProperties } from "react";
import { SEAT_STATE_LABELS, Seat, type SeatState } from "./seat.js";

/** The hall has a centre aisle between seats 5 and 6. */
const AISLE_AFTER = SEATS_PER_ROW / 2;

const ROWS = SEAT_ROWS.map((row, index) => {
  const seats = ALL_SEAT_LABELS.slice(index * SEATS_PER_ROW, (index + 1) * SEATS_PER_ROW).map(
    (label) => ({ label, number: Number(label.slice(row.length)) }),
  );
  return { row, index, left: seats.slice(0, AISLE_AFTER), right: seats.slice(AISLE_AFTER) };
});

const LEGEND: ReadonlyArray<{ state: SeatState; hint: string }> = [
  { state: "available", hint: "Shows its seat number" },
  { state: "held-by-you", hint: "Yours while the hold lasts" },
  { state: "held-by-other", hint: "Frees up if their hold expires" },
  { state: "confirmed", hint: "Paid for and final" },
];

const first = SEAT_ROWS[0];
const last = SEAT_ROWS[SEAT_ROWS.length - 1];

function RowLetter({ row }: { row: string }) {
  return (
    <span className="w-(--hall-letter) shrink-0 text-center font-display text-sm font-bold text-hall-ink-muted sm:text-base">
      {row}
    </span>
  );
}

export function HallPreview() {
  return (
    <figure className="@container relative isolate overflow-hidden rounded-[1.75rem_1.75rem_0.75rem_0.75rem] border border-hall-edge bg-hall px-3 pt-6 pb-5 text-hall-ink sm:px-8 sm:pt-8 sm:pb-6">
      {/* Projector light falling from the screen onto the front rows. */}
      <div
        aria-hidden="true"
        className="screen-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-3/4 bg-[radial-gradient(ellipse_60%_70%_at_50%_0%,color-mix(in_oklab,var(--screen-light)_22%,transparent),transparent_75%)]"
      />
      <div className="mx-auto flex w-4/5 flex-col items-center gap-2">
        <div
          aria-hidden="true"
          className="h-1.5 w-full rounded-[50%/100%_100%_0_0] bg-screen-light shadow-[0_0_28px_4px_color-mix(in_oklab,var(--screen-light)_45%,transparent)]"
        />
        <p className="text-xs text-hall-ink-muted">Screen</p>
      </div>

      <div
        role="img"
        aria-label={`Seat plan: ${SEAT_ROWS.length} rows, ${first} to ${last}, of ${SEATS_PER_ROW} seats each, split by a centre aisle. ${TOTAL_SEATS} seats in total, all shown as available.`}
        className="hall-plan mt-5 flex flex-col items-center gap-seat-gap sm:mt-6"
      >
        {ROWS.map(({ row, index, left, right }) => (
          <div
            key={row}
            className="seat-row flex items-center gap-(--hall-row-gap)"
            style={{ "--row-index": index } as CSSProperties}
          >
            <RowLetter row={row} />
            <div className="flex gap-seat-gap">
              {left.map((seat) => (
                <Seat key={seat.label} state="available" number={seat.number} />
              ))}
            </div>
            <div className="w-(--hall-aisle) shrink-0" />
            <div className="flex gap-seat-gap">
              {right.map((seat) => (
                <Seat key={seat.label} state="available" number={seat.number} />
              ))}
            </div>
            <RowLetter row={row} />
          </div>
        ))}
      </div>

      <figcaption className="mt-6 border-t border-hall-edge pt-4">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 min-[420px]:grid-cols-2">
          {LEGEND.map(({ state, hint }) => (
            <li key={state} className="flex items-center gap-3">
              <Seat state={state} number={7} />
              <span className="flex flex-col">
                <span className="text-sm font-bold">{SEAT_STATE_LABELS[state]}</span>
                <span className="text-xs text-hall-ink-muted">{hint}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-hall-ink-muted">
          A preview of the hall. Every seat is drawn as available; live seat states arrive when booking opens.
        </p>
      </figcaption>
    </figure>
  );
}
