import { ERROR_CODES } from "@seatrush/shared";
import { describe, expect, it } from "vitest";
import type { FailureCode } from "../src/lib/booking-api.js";
import { formatSeatList, holdFailureMessage, releaseFailureMessage } from "../src/lib/messages.js";
import { formatPaise } from "../src/lib/money.js";

const ALL_CODES: FailureCode[] = [...ERROR_CODES, "network", "invalid_response"];

describe("holdFailureMessage", () => {
  it("names the seats another customer took and says the rest stay chosen", () => {
    expect(holdFailureMessage({ code: "seat_unavailable", takenLabels: ["B7", "B8"] })).toBe(
      "B7 and B8 were just taken by another customer, so nothing was held. The rest of your selection is still chosen.",
    );
  });

  it("still explains a conflict when the server did not say which seat", () => {
    expect(holdFailureMessage({ code: "seat_unavailable" })).toMatch(/^One of those seats was just taken/);
  });

  it("never claims nothing was held when the answer was lost", () => {
    expect(holdFailureMessage({ code: "network" })).not.toMatch(/nothing was held/);
    expect(holdFailureMessage({ code: "internal_error", requestId: "abc" })).not.toMatch(/nothing was held/);
  });

  it("includes the request id for unexpected errors", () => {
    expect(holdFailureMessage({ code: "internal_error", requestId: "abc" })).toMatch(/Reference abc\./);
  });

  it.each(ALL_CODES)("has a complete, non-empty sentence for %s", (code) => {
    for (const text of [holdFailureMessage({ code }), releaseFailureMessage({ code })]) {
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toMatch(/!|undefined/);
    }
  });
});

describe("formatSeatList", () => {
  it.each([
    [["B7"], "B7"],
    [["B7", "B8"], "B7 and B8"],
    [["B7", "B8", "B9"], "B7, B8 and B9"],
  ])("%j reads %s", (labels, text) => {
    expect(formatSeatList(labels)).toBe(text);
  });
});

describe("formatPaise", () => {
  it("shows whole rupees without decimals and paise when present", () => {
    expect(formatPaise(20_000)).toBe("₹200");
    expect(formatPaise(80_000)).toBe("₹800");
    expect(formatPaise(120_000_00)).toBe("₹1,20,000");
    expect(formatPaise(20_050)).toBe("₹200.50");
  });
});
