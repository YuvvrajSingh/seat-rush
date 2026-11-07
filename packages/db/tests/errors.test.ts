import { describe, expect, it } from "vitest";
import { classifyDbError } from "../src/errors.js";

describe("database error classification", () => {
  it.each([
    [{ code: "P2010", meta: { driverAdapterError: { cause: { code: "SR409" } } } }, "seat_conflict"],
    [{ name: "DriverAdapterError", cause: { code: "SR410" } }, "active_hold_exists"],
    [{ code: "P2010", meta: { driverAdapterError: { cause: { code: "23P01", message: "holds_one_active_customer" } } } }, "active_hold_exists"],
    [{ name: "DriverAdapterError", cause: { code: "22023" } }, "invalid_input"],
    [{ code: "P2010", meta: { driverAdapterError: { cause: { code: "22P02" } } } }, "invalid_input"],
    [{ code: "P2010", meta: { driverAdapterError: { cause: { kind: "TransactionWriteConflict", originalCode: "40P01" } } } }, "retryable"],
    [{ name: "DriverAdapterError", cause: { originalCode: "40001" } }, "retryable"],
    [{ code: "P2034" }, "retryable"],
    [{ cause: { code: "23P01", message: "unrelated exclusion constraint" } }, "internal"],
    [{ cause: { code: "23514" } }, "internal"],
    [new Error("unrecognized"), "internal"],
    [null, "internal"],
  ] as const)("classifies adapter shape %#", (error, expected) => {
    expect(classifyDbError(error)).toBe(expected);
  });
});
