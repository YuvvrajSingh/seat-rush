import { MAX_SEATS_PER_HOLD } from "@seatrush/shared";
import type { SeatState } from "./seat-map.js";

/**
 * Seat selection is local only (prd §6: selecting does not reserve). The rules here decide what a
 * press on a seat does before anything is sent to the box office.
 */
export type ToggleResult =
  | { kind: "changed"; selection: readonly string[] }
  /** Only available seats can be chosen; the server still revalidates on hold. */
  | { kind: "unavailable" }
  /** FR-02 caps a hold at MAX_SEATS_PER_HOLD seats. */
  | { kind: "limit" }
  /** One active hold per customer per screening (FR-02): release it before choosing again. */
  | { kind: "hold-active" };

export function toggleSeat(
  selection: readonly string[],
  seat: { id: string; state: SeatState },
  { holdActive }: { holdActive: boolean },
): ToggleResult {
  if (holdActive) return { kind: "hold-active" };
  if (selection.includes(seat.id)) {
    return { kind: "changed", selection: selection.filter((id) => id !== seat.id) };
  }
  if (seat.state !== "available") return { kind: "unavailable" };
  if (selection.length >= MAX_SEATS_PER_HOLD) return { kind: "limit" };
  return { kind: "changed", selection: [...selection, seat.id] };
}

export interface Reconciled {
  selection: readonly string[];
  /** Selected seats another customer now holds or has bought. */
  takenByOthers: readonly string[];
}

/**
 * Re-checks a selection against a fresh seat map. Seats that stopped being available leave the
 * selection; those now owned by someone else are reported so the UI can say so. Seats that are
 * now held by this customer leave silently, because a hold already covers them.
 */
export function reconcileSelection(
  selection: readonly string[],
  stateById: ReadonlyMap<string, SeatState>,
): Reconciled {
  const kept: string[] = [];
  const takenByOthers: string[] = [];
  for (const id of selection) {
    const state = stateById.get(id);
    if (state === "available") kept.push(id);
    else if (state === "held-by-other" || state === "confirmed") takenByOthers.push(id);
  }
  return {
    selection: kept.length === selection.length ? selection : kept,
    takenByOthers,
  };
}
