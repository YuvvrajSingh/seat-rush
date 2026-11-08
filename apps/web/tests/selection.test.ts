import { MAX_SEATS_PER_HOLD } from "@seatrush/shared";
import { describe, expect, it } from "vitest";
import type { SeatState } from "../src/lib/seat-map.js";
import { reconcileSelection, toggleSeat } from "../src/lib/selection.js";

const available = (id: string) => ({ id, state: "available" as const });
const free = { holdActive: false };

describe("toggleSeat", () => {
  it("adds an available seat and removes it on a second press", () => {
    const added = toggleSeat([], available("a"), free);
    expect(added).toEqual({ kind: "changed", selection: ["a"] });
    expect(toggleSeat(["a"], available("a"), free)).toEqual({ kind: "changed", selection: [] });
  });

  it(`caps the selection at ${MAX_SEATS_PER_HOLD} seats`, () => {
    let selection: readonly string[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      const result = toggleSeat(selection, available(id), free);
      if (result.kind !== "changed") throw new Error(`seat ${id} was refused: ${result.kind}`);
      selection = result.selection;
    }
    expect(selection).toHaveLength(MAX_SEATS_PER_HOLD);
    expect(toggleSeat(selection, available("e"), free)).toEqual({ kind: "limit" });
  });

  it("still lets a full selection drop a seat", () => {
    expect(toggleSeat(["a", "b", "c", "d"], available("b"), free)).toEqual({
      kind: "changed",
      selection: ["a", "c", "d"],
    });
  });

  it.each<SeatState>(["held-by-you", "held-by-other", "confirmed"])("refuses a %s seat", (state) => {
    expect(toggleSeat([], { id: "a", state }, free)).toEqual({ kind: "unavailable" });
  });

  it("lets a seat that became unavailable be deselected, so a stale choice can be undone", () => {
    expect(toggleSeat(["a"], { id: "a", state: "held-by-other" }, free)).toEqual({ kind: "changed", selection: [] });
  });

  it("refuses every change while the customer has an active hold", () => {
    expect(toggleSeat([], available("a"), { holdActive: true })).toEqual({ kind: "hold-active" });
  });

  it("does not mutate the selection it was given", () => {
    const selection = ["a"];
    toggleSeat(selection, available("b"), free);
    expect(selection).toEqual(["a"]);
  });
});

describe("reconcileSelection", () => {
  const states = new Map<string, SeatState>([
    ["a", "available"],
    ["b", "held-by-other"],
    ["c", "confirmed"],
    ["d", "held-by-you"],
  ]);

  it("keeps available seats and reports the ones another customer took", () => {
    expect(reconcileSelection(["a", "b", "c"], states)).toEqual({ selection: ["a"], takenByOthers: ["b", "c"] });
  });

  it("drops seats now held by this customer without calling them taken", () => {
    expect(reconcileSelection(["a", "d"], states)).toEqual({ selection: ["a"], takenByOthers: [] });
  });

  it("drops seats the snapshot no longer lists", () => {
    expect(reconcileSelection(["a", "zz"], states)).toEqual({ selection: ["a"], takenByOthers: [] });
  });

  it("returns the same array when nothing changed, so React can skip work", () => {
    const selection = ["a"];
    expect(reconcileSelection(selection, states).selection).toBe(selection);
  });
});
