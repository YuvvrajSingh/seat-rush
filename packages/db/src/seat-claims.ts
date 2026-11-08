import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";

export type SqlTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

export interface SeatClaim {
  id: string;
  screeningId: string;
  customerId: string;
  seatCount: number;
  amountPaise: number;
  createdAt: Date;
  expiresAt: Date;
  seats: { id: string; label: string }[];
}

export interface SeatClaimRequest {
  screeningId: string;
  customerId: string;
  seatIds: readonly string[];
}

/** Compose with idempotency/outbox writes in the caller's Read Committed transaction. */
export async function claimSeatsInTransaction(tx: SqlTransaction, request: SeatClaimRequest): Promise<SeatClaim> {
  const [hold] = await tx.$queryRaw<SeatClaim[]>`
    SELECT h.id, h.screening_id AS "screeningId", h.customer_id AS "customerId",
      h.seat_count AS "seatCount", h.amount_paise AS "amountPaise",
      h.created_at AS "createdAt", h.expires_at AS "expiresAt",
      (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'label', s.label) ORDER BY s.row, s.number)
        FROM seats s WHERE s.id = ANY(${request.seatIds}::uuid[])) AS seats
    FROM claim_seats(${request.screeningId}::uuid, ${request.customerId}::uuid, ${request.seatIds}::uuid[]) h
  `;
  if (!hold) throw new Error("claim_seats returned no hold");
  return hold;
}

export function claimSeats(prisma: PrismaClient, request: SeatClaimRequest): Promise<SeatClaim> {
  return prisma.$transaction((tx) => claimSeatsInTransaction(tx, request), { maxWait: 30_000, timeout: 30_000 });
}

/** Locks screening, hold, then seats by id; returns only cleared pointers in row/number order. */
export async function cleanupExpiredHoldInTransaction(tx: SqlTransaction, holdId: string): Promise<{ id: string; label: string }[]> {
  return tx.$queryRaw<{ id: string; label: string }[]>`SELECT id, label FROM cleanup_expired_hold(${holdId}::uuid)`;
}

export function cleanupExpiredHold(prisma: PrismaClient, holdId: string): Promise<number> {
  return prisma.$transaction(async (tx) => (await cleanupExpiredHoldInTransaction(tx, holdId)).length);
}

export async function releaseHoldInTransaction(tx: SqlTransaction, holdId: string, customerId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ cleared: number }[]>`
    SELECT release_hold(${holdId}::uuid, ${customerId}::uuid) AS cleared`;
  return row?.cleared ?? 0;
}

export function releaseHold(prisma: PrismaClient, holdId: string, customerId: string): Promise<number> {
  return prisma.$transaction((tx) => releaseHoldInTransaction(tx, holdId, customerId));
}
