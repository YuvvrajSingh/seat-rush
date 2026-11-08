import { describe, expect, it } from "vitest";
import {
  clockOffsetMs,
  countdownState,
  describeRemaining,
  formatRemaining,
  remainingMs,
} from "../src/lib/countdown.js";

const at = (iso: string) => Date.parse(iso);

describe("clockOffsetMs", () => {
  it("is positive when the local clock runs behind the server", () => {
    // Local clock reads 10:00:00.000 → 10:00:00.200; the server said 10:00:30.100.
    expect(clockOffsetMs("2026-11-07T10:00:30.100Z", at("2026-11-07T10:00:00.000Z"), at("2026-11-07T10:00:00.200Z"))).toBe(
      30_000,
    );
  });

  it("uses the midpoint of the request, not the moment the answer arrived", () => {
    // Same clocks, 2 s round trip: the server read its clock around the middle.
    const offset = clockOffsetMs("2026-11-07T10:00:01.000Z", at("2026-11-07T10:00:00.000Z"), at("2026-11-07T10:00:02.000Z"));
    expect(offset).toBe(0);
  });
});

describe("remainingMs", () => {
  const expiresAt = "2026-11-07T10:05:00.000Z";

  it("counts against the corrected server clock", () => {
    const localNow = at("2026-11-07T10:00:00.000Z");
    expect(remainingMs(expiresAt, localNow, 0)).toBe(300_000);
    // The local clock is a minute fast (server is behind): 6 minutes really remain.
    expect(remainingMs(expiresAt, localNow, -60_000)).toBe(360_000);
    // The local clock is a minute slow: only 4 minutes remain.
    expect(remainingMs(expiresAt, localNow, 60_000)).toBe(240_000);
  });

  it("never goes below zero", () => {
    expect(remainingMs(expiresAt, at("2026-11-07T11:00:00.000Z"), 0)).toBe(0);
  });
});

describe("countdownState", () => {
  const hold = { status: "active" as const, expiresAt: "2026-11-07T10:05:00.000Z" };

  it("counts while time remains", () => {
    expect(countdownState(hold, at("2026-11-07T10:04:59.000Z"), 0)).toEqual({ phase: "counting", remainingMs: 1_000 });
  });

  it("asks the server at zero and never reports the seats as available itself", () => {
    const state = countdownState(hold, at("2026-11-07T10:05:00.000Z"), 0);
    expect(state).toEqual({ phase: "checking" });
    expect(countdownState(hold, at("2026-11-07T10:30:00.000Z"), 0)).toEqual({ phase: "checking" });
  });

  it("reaches zero early when the local clock is slow, by the skew", () => {
    // Local 10:04:30, but the server is 30 s ahead: the hold is at its end now.
    expect(countdownState(hold, at("2026-11-07T10:04:30.000Z"), 30_000)).toEqual({ phase: "checking" });
  });

  it("does not count down a hold the server already ended", () => {
    expect(countdownState({ ...hold, status: "expired" }, at("2026-11-07T10:00:00.000Z"), 0)).toEqual({
      phase: "checking",
    });
  });
});

describe("formatRemaining", () => {
  it.each([
    [300_000, "5:00"],
    [299_200, "5:00"],
    [299_000, "4:59"],
    [61_000, "1:01"],
    [9_000, "0:09"],
    [1, "0:01"],
    [0, "0:00"],
    [-5, "0:00"],
  ])("%i ms reads %s", (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});

describe("describeRemaining", () => {
  it.each([
    [300_000, "5 minutes"],
    [61_000, "1 minute 1 second"],
    [125_000, "2 minutes 5 seconds"],
    [9_000, "9 seconds"],
    [0, "0 seconds"],
  ])("%i ms reads %s", (ms, text) => {
    expect(describeRemaining(ms)).toBe(text);
  });
});
