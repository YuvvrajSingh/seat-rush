import type { Hold } from "@seatrush/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/booking-api.js";
import { createHoldCheck, type HoldCheckResult } from "../src/lib/hold-check.js";
import { makeHold } from "./fixtures.js";

describe("createHoldCheck", () => {
  it("keeps one slow request per hold and still delivers its answer while snapshots keep asking", async () => {
    const hold = makeHold(["B7"], { status: "expired" });
    const answers: Array<PromiseWithResolvers<Hold>> = [];
    const results: HoldCheckResult[] = [];
    const check = createHoldCheck(
      () => {
        const answer = Promise.withResolvers<Hold>();
        answers.push(answer);
        return answer.promise;
      },
      (result) => results.push(result),
    );

    // Snapshots every 2 s re-run the check while the first request is still out.
    const first = check(hold.id);
    await check(hold.id);
    await check(hold.id);
    expect(answers).toHaveLength(1);

    answers[0]?.resolve(hold);
    await first;
    expect(results).toEqual([{ type: "hold-status", hold }]);

    // Once answered, a later snapshot may ask again.
    void check(hold.id);
    expect(answers).toHaveLength(2);
  });

  it("reports a 404 as gone, ignores other failures, and allows a retry after either", async () => {
    const hold = makeHold(["B7"]);
    const results: HoldCheckResult[] = [];
    let failure: unknown = new ApiError("network", "down");
    let calls = 0;
    const check = createHoldCheck(
      () => {
        calls += 1;
        return Promise.reject(failure);
      },
      (result) => results.push(result),
    );

    await check(hold.id);
    expect(results).toEqual([]);

    failure = new ApiError("not_found", "gone", 404);
    await check(hold.id);
    expect(calls).toBe(2);
    expect(results).toEqual([{ type: "hold-gone", holdId: hold.id }]);
  });
});
