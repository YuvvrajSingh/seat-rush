import { describe, expect, it } from "vitest";
import { nextGridPosition } from "../src/lib/grid-navigation.js";
import { buildHall, seatAccessibleName, seatState } from "../src/lib/seat-map.js";
import { makeSnapshot } from "./fixtures.js";

describe("seatState", () => {
  it("maps the public state plus the viewer flag onto the four FR-01 states", () => {
    expect(seatState({ state: "available", heldByYou: false })).toBe("available");
    expect(seatState({ state: "held", heldByYou: true })).toBe("held-by-you");
    expect(seatState({ state: "held", heldByYou: false })).toBe("held-by-other");
    expect(seatState({ state: "confirmed", heldByYou: false })).toBe("confirmed");
  });
});

describe("buildHall", () => {
  it("lays out ten rows of ten, front row first, seats in number order, whatever order the API sent", () => {
    const { seats } = makeSnapshot({ seats: { B7: { state: "held", heldByYou: true } } });
    const hall = buildHall(seats.toReversed());
    expect(hall.map((row) => row.row)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(hall[0]?.seats.map((seat) => seat.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(hall[1]?.seats[6]).toMatchObject({ label: "B7", state: "held-by-you" });
  });
});

describe("seatAccessibleName", () => {
  it("names the seat and its state", () => {
    expect(seatAccessibleName({ label: "B7", state: "held-by-other" })).toBe("B7, held by another customer");
    expect(seatAccessibleName({ label: "A1", state: "available" })).toBe("A1, available");
    expect(seatAccessibleName({ label: "C3", state: "held-by-you" })).toBe("C3, held by you");
    expect(seatAccessibleName({ label: "D4", state: "confirmed" })).toBe("D4, confirmed");
  });

  it("adds why a seat is highlighted after a refused hold", () => {
    expect(seatAccessibleName({ label: "B7", state: "held-by-other" }, "taken")).toBe(
      "B7, held by another customer, just taken",
    );
  });

  it("leaves selection to aria-pressed instead of the name", () => {
    expect(seatAccessibleName({ label: "A1", state: "available" }, "selected")).toBe("A1, available");
  });
});

describe("nextGridPosition", () => {
  const rows = Array.from({ length: 10 }, () => 10);
  const middle = { row: 4, col: 4 };

  it("moves one seat with the arrow keys", () => {
    expect(nextGridPosition(middle, { key: "ArrowLeft" }, rows)).toEqual({ row: 4, col: 3 });
    expect(nextGridPosition(middle, { key: "ArrowRight" }, rows)).toEqual({ row: 4, col: 5 });
    expect(nextGridPosition(middle, { key: "ArrowUp" }, rows)).toEqual({ row: 3, col: 4 });
    expect(nextGridPosition(middle, { key: "ArrowDown" }, rows)).toEqual({ row: 5, col: 4 });
  });

  it("stops at the edges instead of wrapping", () => {
    expect(nextGridPosition({ row: 0, col: 0 }, { key: "ArrowLeft" }, rows)).toEqual({ row: 0, col: 0 });
    expect(nextGridPosition({ row: 0, col: 0 }, { key: "ArrowUp" }, rows)).toEqual({ row: 0, col: 0 });
    expect(nextGridPosition({ row: 9, col: 9 }, { key: "ArrowRight" }, rows)).toEqual({ row: 9, col: 9 });
    expect(nextGridPosition({ row: 9, col: 9 }, { key: "ArrowDown" }, rows)).toEqual({ row: 9, col: 9 });
  });

  it("goes to the row ends with Home and End, and the hall ends with Ctrl", () => {
    expect(nextGridPosition(middle, { key: "Home" }, rows)).toEqual({ row: 4, col: 0 });
    expect(nextGridPosition(middle, { key: "End" }, rows)).toEqual({ row: 4, col: 9 });
    expect(nextGridPosition(middle, { key: "Home", ctrlKey: true }, rows)).toEqual({ row: 0, col: 0 });
    expect(nextGridPosition(middle, { key: "End", ctrlKey: true }, rows)).toEqual({ row: 9, col: 9 });
  });

  it("goes to the front and back rows with PageUp and PageDown", () => {
    expect(nextGridPosition(middle, { key: "PageUp" }, rows)).toEqual({ row: 0, col: 4 });
    expect(nextGridPosition(middle, { key: "PageDown" }, rows)).toEqual({ row: 9, col: 4 });
  });

  it("clamps into shorter rows", () => {
    expect(nextGridPosition({ row: 0, col: 9 }, { key: "ArrowDown" }, [10, 6])).toEqual({ row: 1, col: 5 });
  });

  it("ignores other keys so Tab, Enter and Space keep their meaning", () => {
    for (const key of ["Tab", "Enter", " ", "a"]) expect(nextGridPosition(middle, { key }, rows)).toBeNull();
  });
});
