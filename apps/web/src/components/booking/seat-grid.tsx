"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { nextGridPosition, type GridPosition } from "../../lib/grid-navigation.js";
import { AISLE_AFTER, seatAccessibleName, type HallRow, type SeatMark, type SeatView } from "../../lib/seat-map.js";
import { RowLetter } from "../hall.js";
import { SeatFace, seatClassName } from "../seat.js";

interface SeatGridProps {
  rows: readonly HallRow[];
  selection: ReadonlySet<string>;
  taken: ReadonlySet<string>;
  onToggle: (seatId: string) => void;
  /** Id of the element that explains how to use the grid. */
  describedBy: string;
}

/** First available seat, so Tab lands somewhere useful; the front-left seat otherwise. */
function initialPosition(rows: readonly HallRow[]): GridPosition {
  for (const [row, { seats }] of rows.entries()) {
    const col = seats.findIndex((seat) => seat.state === "available");
    if (col >= 0) return { row, col };
  }
  return { row: 0, col: 0 };
}

function markFor(seat: SeatView, selection: ReadonlySet<string>, taken: ReadonlySet<string>): SeatMark | undefined {
  if (selection.has(seat.id)) return "selected";
  if (taken.has(seat.id)) return "taken";
  return undefined;
}

/**
 * The customer's selection surface (prd §9 accessible DOM grid): one button per seat, one tab
 * stop for the whole hall, arrow keys between seats. Selection is local; pressing a seat sends
 * nothing to the box office.
 */
export function SeatGrid({ rows, selection, taken, onToggle, describedBy }: SeatGridProps) {
  const [focus, setFocus] = useState<GridPosition | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const active = focus ?? initialPosition(rows);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextGridPosition(
      active,
      event,
      rows.map((row) => row.seats.length),
    );
    if (!next) return;
    event.preventDefault();
    setFocus(next);
    buttons.current.get(`${next.row}:${next.col}`)?.focus();
  }

  return (
    <div
      role="grid"
      aria-label="Seats, screen at the top"
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      className="hall-plan mt-5 flex flex-col items-center gap-seat-gap sm:mt-6"
    >
      {rows.map(({ row, seats }, rowIndex) => (
        <div
          key={row}
          role="row"
          className="seat-row flex items-center gap-(--hall-row-gap)"
          style={{ "--row-index": rowIndex } as CSSProperties}
        >
          <RowLetter row={row} role="rowheader" aria-label={`Row ${row}`} />
          {[seats.slice(0, AISLE_AFTER), seats.slice(AISLE_AFTER)].map((half, halfIndex) => (
            // The aisle matches the static preview: its own width plus a row gap on each side.
            <div
              key={halfIndex}
              className={`flex gap-seat-gap ${halfIndex === 1 ? "ms-[calc(var(--hall-aisle)+var(--hall-row-gap))]" : ""}`}
            >
              {half.map((seat, indexInHalf) => {
                const col = halfIndex * AISLE_AFTER + indexInHalf;
                const mark = markFor(seat, selection, taken);
                const selected = mark === "selected";
                const choosable = seat.state === "available" || selected;
                const isActive = active.row === rowIndex && active.col === col;
                return (
                  <div key={seat.id} role="gridcell">
                    <button
                      ref={(node) => {
                        const key = `${rowIndex}:${col}`;
                        if (node) buttons.current.set(key, node);
                        else buttons.current.delete(key);
                      }}
                      type="button"
                      tabIndex={isActive ? 0 : -1}
                      aria-label={seatAccessibleName(seat, mark)}
                      aria-pressed={choosable ? selected : undefined}
                      aria-disabled={choosable ? undefined : true}
                      onClick={() => onToggle(seat.id)}
                      onFocus={() => setFocus({ row: rowIndex, col })}
                      className={`seat-button ${seatClassName(seat.state, mark)}`}
                    >
                      <SeatFace state={seat.state} number={seat.number} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          <RowLetter row={row} aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}
