import { createHash } from "node:crypto";
import { classifyDbError, takeOverStaleIdempotency, type PrismaClient, type SqlTransaction } from "@seatrush/db";
import { HttpError } from "./middleware/errors.js";
import { withDbRetry } from "./booking.js";

export interface StoredResponse { status: number; body: unknown; replayed?: boolean }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${key === "seatIds" && Array.isArray(item) ? canonical([...item].sort()) : canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** FR-06: short committed acquisition; fenced execution and result commit atomically. */
export async function idempotent(db: PrismaClient, input: {
  customerId: string; screeningId: string | null; operation: string; key: string;
  payload: unknown; requestId: string;
}, execute: (tx: SqlTransaction, store: (response: StoredResponse) => Promise<void>) => Promise<StoredResponse>): Promise<StoredResponse> {
  const requestHash = createHash("sha256").update(canonical(input.payload)).digest("hex");
  const scope = { ...input, requestHash };
  const acquired = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM screenings WHERE id = ${input.screeningId}::uuid FOR KEY SHARE`;
    const [created] = await tx.$queryRaw<{ id: string; leaseToken: string }[]>`
      INSERT INTO idempotency_records (customer_id, screening_id, operation, key, request_hash)
      VALUES (${input.customerId}::uuid, (SELECT id FROM screenings WHERE id = ${input.screeningId}::uuid),
        ${input.operation}, ${input.key}, ${requestHash})
      ON CONFLICT (customer_id, operation, key) DO NOTHING
      RETURNING id, locked_until::text AS "leaseToken"`;
    if (created) return { lease: created };
    const [record] = await tx.$queryRaw<{ requestHash: string; status: string; responseCode: number; responseBody: unknown; retryAfter: number }[]>`
      SELECT request_hash AS "requestHash", status, response_code AS "responseCode", response_body AS "responseBody",
        greatest(1, ceil(extract(epoch FROM locked_until - clock_timestamp())))::int AS "retryAfter"
      FROM idempotency_records WHERE customer_id = ${input.customerId}::uuid AND operation = ${input.operation} AND key = ${input.key}`;
    if (!record) throw new HttpError(409, "idempotency_in_progress", "The previous execution was reset; retry with the same key", { retryAfter: 1 });
    if (record.requestHash !== requestHash) throw new HttpError(409, "idempotency_key_reused", "Idempotency key was already used with a different payload");
    if (record.status === "completed") return { response: { status: record.responseCode, body: record.responseBody } };
    const lease = await takeOverStaleIdempotency(tx, scope);
    if (!lease) throw new HttpError(409, "idempotency_in_progress", "This operation is still in progress; retry with the same key", { retryAfter: record.retryAfter });
    return { lease };
  }, { maxWait: 30_000, timeout: 30_000 });
  if (acquired.response) return { ...acquired.response, replayed: true };
  const lease = acquired.lease!;
  try {
    return await withDbRetry(() => db.$transaction(async (tx) => {
      // Reset takes this lock before deleting leases. Match that order before fencing execution.
      await tx.$queryRaw`SELECT 1 FROM screenings WHERE id = ${input.screeningId}::uuid FOR KEY SHARE`;
      const [owner] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM idempotency_records WHERE id = ${lease.id}::uuid
          AND status = 'in_progress' AND locked_until::text = ${lease.leaseToken} FOR UPDATE`;
      if (!owner) throw new HttpError(409, "idempotency_in_progress", "This operation is owned by another execution", { retryAfter: 1 });
      await tx.$executeRaw`SAVEPOINT booking_operation`;
      let stored = false;
      // Hold writers call this before their final ordered-event insert.
      const store = async (response: StoredResponse): Promise<void> => {
        if (response.status >= 500) throw new Error("Server responses must not be retained");
        await tx.$executeRaw`UPDATE idempotency_records SET status = 'completed', response_code = ${response.status},
          response_body = ${JSON.stringify(response.body)}::jsonb, retain_until = greatest(retain_until, now() + interval '24 hours')
          WHERE id = ${lease.id}::uuid AND locked_until::text = ${lease.leaseToken}`;
        stored = true;
      };
      let response: StoredResponse;
      try { response = await execute(tx, store); }
      catch (error) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT booking_operation`;
        stored = false;
        const classification = classifyDbError(error);
        if (classification === "retryable" || classification === "unavailable") throw error;
        let known: unknown = error;
        try { await withDbRetry(async () => { throw error; }); } catch (mapped) { known = mapped; }
        if (!(known instanceof HttpError) || known.status >= 500) throw known;
        response = { status: known.status, body: { error: { code: known.code, message: known.message,
          requestId: input.requestId, ...(known.options?.seatIds ? { seatIds: known.options.seatIds } : {}) } } };
      }
      if (!stored) await store(response);
      return response;
    }, { maxWait: 30_000, timeout: 30_000 }));
  } catch (error) {
    await db.$executeRaw`DELETE FROM idempotency_records WHERE id = ${lease.id}::uuid
      AND status = 'in_progress' AND locked_until::text = ${lease.leaseToken}`;
    throw error;
  }
}
