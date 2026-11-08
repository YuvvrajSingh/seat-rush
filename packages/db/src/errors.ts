export type DbErrorKind = "seat_conflict" | "active_hold_exists" | "invalid_input" | "not_found" | "unauthorized" | "retryable" | "unavailable" | "internal";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** Normalize Prisma statement errors, deferred-commit errors and adapter write conflicts. */
export function classifyDbError(error: unknown): DbErrorKind {
  const root = record(error);
  const adapter = record(record(root.meta).driverAdapterError);
  const cause = record(adapter.cause ?? root.cause);
  const code = cause.originalCode ?? cause.code ?? record(root.meta).code ?? root.code;
  if (code === "SR409") return "seat_conflict";
  if (code === "SR410") return "active_hold_exists";
  if (code === "SR404") return "not_found";
  if (code === "SR401") return "unauthorized";
  if (cause.kind === "DatabaseNotReachable") return "unavailable";
  if (typeof code === "string" && (code.startsWith("08") || ["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "P1001", "P1002", "P1017", "P2024", "P2028"].includes(code))) return "unavailable";
  if ([root.message, adapter.message, cause.message].some((message) => typeof message === "string"
    && /timeout exceeded when trying to connect|timed out fetching a new connection|unable to start a transaction in the given time|connection terminated|ECONNREFUSED/i.test(message))) return "unavailable";
  if (code === "23P01" && [root.message, adapter.message, cause.message, cause.constraint].some(
    (value) => typeof value === "string" && value.includes("holds_one_active_customer"),
  )) return "active_hold_exists";
  if (code === "22023" || code === "22P02") return "invalid_input";
  if (code === "40P01" || code === "40001" || code === "P2034") return "retryable";
  return "internal";
}
