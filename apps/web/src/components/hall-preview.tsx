import { ALL_SEAT_LABELS, SEAT_ROWS, SEATS_PER_ROW, TOTAL_SEATS } from "@seatrush/shared";
import Link from "next/link";
import type { CSSProperties } from "react";
import { AISLE_AFTER } from "../lib/seat-map.js";
import { Auditorium, RowLetter, SeatLegend } from "./hall.js";
import { Seat } from "./seat.js";

const ROWS = SEAT_ROWS.map((row, index) => {
  const seats = ALL_SEAT_LABELS.slice(index * SEATS_PER_ROW, (index + 1) * SEATS_PER_ROW).map(
    (label) => ({ label, number: Number(label.slice(row.length)) }),
  );
  return { row, index, left: seats.slice(0, AISLE_AFTER), right: seats.slice(AISLE_AFTER) };
});

const first = SEAT_ROWS[0];
const last = SEAT_ROWS[SEAT_ROWS.length - 1];

/** A static drawing of the hall for the home page. It shows layout only, never seat states. */
export function HallPreview() {
  return (
    <Auditorium
      caption={
        <>
          <SeatLegend />
          <p className="mt-4 text-xs text-hall-ink-muted">
            A drawing of the hall, with every seat shown as available. For real seat states,{" "}
            <Link href="/book" className="font-bold text-hall-ink underline decoration-1 underline-offset-3 hover:decoration-2">
              open the booking page
            </Link>
            .
          </p>
        </>
      }
    >
      <div
        role="img"
        aria-label={`Seat plan: ${SEAT_ROWS.length} rows, ${first} to ${last}, of ${SEATS_PER_ROW} seats each, split by a centre aisle. ${TOTAL_SEATS} seats in total, all drawn as available.`}
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
    </Auditorium>
  );
}
