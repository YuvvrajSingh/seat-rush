import type { SqlTransaction } from "./seat-claims.js";

/** Run in a short acquisition transaction, committed before doing request work.
 * A false result means another execution owns the lease, the payload differs, or the result is final.
 * Finalization must compare the returned lease token so a stale owner cannot complete a replacement's work.
 */
export async function takeOverStaleIdempotency(
  tx: SqlTransaction,
  request: { customerId: string; operation: string; key: string; requestHash: string },
): Promise<{ id: string; leaseToken: string } | null> {
  const [record] = await tx.$queryRaw<{ id: string; leaseToken: string }[]>`
    UPDATE idempotency_records SET locked_until = now() + interval '30 seconds'
    WHERE customer_id = ${request.customerId}::uuid AND operation = ${request.operation}
      AND key = ${request.key} AND request_hash = ${request.requestHash}
      AND status = 'in_progress' AND locked_until < now()
    RETURNING id, locked_until::text AS "leaseToken"
  `;
  return record ?? null;
}
