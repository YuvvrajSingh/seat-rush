import type { ComponentProps, ReactNode } from "react";
import { SEAT_STATE_LABELS, type SeatState } from "../lib/seat-map.js";
import { Seat } from "./seat.js";

/**
 * The auditorium: a dark room with the screen at the top and projector light falling on the
 * front rows. Dark in both colour schemes so seat states read the same everywhere.
 * `children` is the seat plan, `caption` sits under a hairline (legend and notes).
 */
export function Auditorium({ children, caption }: { children: ReactNode; caption: ReactNode }) {
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
        <p aria-hidden="true" className="text-xs text-hall-ink-muted">
          Screen
        </p>
      </div>
      {children}
      <figcaption className="mt-6 border-t border-hall-edge pt-4">{caption}</figcaption>
    </figure>
  );
}

export function RowLetter({ row, ...props }: { row: string } & ComponentProps<"span">) {
  return (
    <span
      {...props}
      className="w-(--hall-letter) shrink-0 text-center font-display text-sm font-bold text-hall-ink-muted sm:text-base"
    >
      {row}
    </span>
  );
}

const LEGEND: ReadonlyArray<{ state: SeatState; hint: string }> = [
  { state: "available", hint: "Shows its seat number" },
  { state: "held-by-you", hint: "Yours while the hold lasts" },
  { state: "held-by-other", hint: "Frees up if their hold expires" },
  { state: "confirmed", hint: "Paid for and final" },
];

export function LegendItem({ seat, label, hint }: { seat: ReactNode; label: string; hint: string }) {
  return (
    <li className="flex items-center gap-3">
      {seat}
      <span className="flex flex-col">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-hall-ink-muted">{hint}</span>
      </span>
    </li>
  );
}

/** FR-01 key: every state as its seat drawing plus a text label. Extra entries go in `children`. */
export function SeatLegend({ children }: { children?: ReactNode }) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 min-[420px]:grid-cols-2">
      {LEGEND.map(({ state, hint }) => (
        <LegendItem key={state} seat={<Seat state={state} number={7} />} label={SEAT_STATE_LABELS[state]} hint={hint} />
      ))}
      {children}
    </ul>
  );
}
