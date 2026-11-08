import { describe, expect, it } from "vitest";
import { createActionKeys, holdAction, isUnsettled } from "../src/lib/action-keys.js";
import { ApiError } from "../src/lib/booking-api.js";

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

const action = holdAction("screening", ["a", "b"]);

describe("createActionKeys", () => {
  it("resends the same key when the same action is retried after an unsettled answer", () => {
    const keys = createActionKeys(counter());
    expect(keys.keyFor(action)).toBe("key-1");
    keys.settle(action, new ApiError("network", "no answer"));
    expect(keys.keyFor(action)).toBe("key-1");
    keys.settle(action, new ApiError("retry_later", "busy", 503));
    expect(keys.keyFor(action)).toBe("key-1");
    keys.settle(action, new ApiError("idempotency_in_progress", "running", 409));
    expect(keys.keyFor(action)).toBe("key-1");
  });

  it("uses a new key after a settled answer", () => {
    const keys = createActionKeys(counter());
    keys.keyFor(action);
    keys.settle(action);
    expect(keys.keyFor(action)).toBe("key-2");
    keys.settle(action, new ApiError("seat_unavailable", "taken", 409));
    expect(keys.keyFor(action)).toBe("key-3");
  });

  it("uses a new key for a different action, since the server would reject the reused one", () => {
    const keys = createActionKeys(counter());
    keys.keyFor(action);
    keys.settle(action, new ApiError("network", "no answer"));
    expect(keys.keyFor(holdAction("screening", ["b", "a"]))).toBe("key-2");
  });
});

describe("isUnsettled", () => {
  it.each([
    [new ApiError("network", "x"), true],
    [new ApiError("internal_error", "x", 500), true],
    [new ApiError("invalid_response", "x", 200), true],
    [new ApiError("idempotency_in_progress", "x", 409), true],
    [new ApiError("seat_unavailable", "x", 409), false],
    [new ApiError("idempotency_key_reused", "x", 409), false],
    [new ApiError("unauthorized", "x", 401), false],
    [new Error("bug"), true],
  ])("%s → %s", (error, expected) => {
    expect(isUnsettled(error)).toBe(expected);
  });
});
