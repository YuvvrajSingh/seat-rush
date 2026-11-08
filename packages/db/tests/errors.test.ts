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
    [{ cause: { originalCode: "SR404" } }, "not_found"],
    [{ code: "P2010", meta: { driverAdapterError: { cause: { kind: "DatabaseNotReachable", host: "127.0.0.1", port: 1 } } } }, "unavailable"],
    [{ cause: { originalCode: "SR401" } }, "unauthorized"],
    [{ cause: { originalCode: "08006" } }, "unavailable"],
    [{ cause: { originalCode: "57P01" } }, "unavailable"],
    [{ cause: { originalCode: "ECONNREFUSED" } }, "unavailable"],
    [{ code: "P2024" }, "unavailable"],
    [new Error("timeout exceeded when trying to connect"), "unavailable"],
    [{ code: "P2028", message: "Unable to start a transaction in the given time." }, "unavailable"],
    [{ code: "P2028", message: "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction." }, "unavailable"],
    [{ code: "P2028", meta: { error: "Transaction already closed: A commit cannot be executed on an expired transaction." } }, "unavailable"],
    [{ code: "P2028" }, "unavailable"],
    [{ cause: { code: "23P01", message: "unrelated exclusion constraint" } }, "internal"],
    [{ cause: { code: "23514" } }, "internal"],
    [new Error("unrecognized"), "internal"],
    [null, "internal"],
  ] as const)("classifies adapter shape %#", (error, expected) => {
    expect(classifyDbError(error)).toBe(expected);
  });
});
