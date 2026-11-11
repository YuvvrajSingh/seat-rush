import { SeatEventSchema, type PaymentSimulationJob, type RefundJob } from '@seatrush/shared';
import type { PrismaClient } from './client.js';
import type { SqlTransaction } from './seat-claims.js';

export async function emitPaymentEvent(tx: SqlTransaction, holdId: string, kind: string, fields: Record<string, unknown>, seats = true): Promise<void> {
  const [row] = await tx.$queryRaw<{payload: unknown}[]>`
    INSERT INTO domain_events (screening_id, customer_id, kind, payload)
    SELECT h.screening_id, h.customer_id, ${kind}, jsonb_build_object('kind',${kind}::text,'screeningId',h.screening_id,'holdId',h.id)
      || ${JSON.stringify(fields)}::jsonb || CASE WHEN ${seats} THEN jsonb_build_object('seats',
        (SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',s.label) ORDER BY s.row,s.number)
         FROM hold_items hi JOIN seats s ON s.id=hi.seat_id WHERE hi.hold_id=h.id)) ELSE '{}'::jsonb END
    FROM holds h WHERE h.id=${holdId}::uuid RETURNING payload`;
  SeatEventSchema.parse(row?.payload);
}

export async function findStalledPaymentAttempts(prisma: PrismaClient, {olderThanMs, limit}: {olderThanMs:number;limit:number}): Promise<PaymentSimulationJob[]> {
  return prisma.$queryRaw<PaymentSimulationJob[]>`SELECT a.id AS "paymentAttemptId", a.scenario, a.delay_ms AS "delayMs",
    floor(extract(epoch FROM a.created_at) * 1000)::float8 AS "attemptCreatedAt"
    FROM payment_attempts a WHERE a.status='initiated' AND a.created_at <= now() - ${olderThanMs} * interval '1 millisecond'
      AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.payment_attempt_id=a.id AND e.disposition='applied' AND e.outcome IN ('succeeded','failed'))
    ORDER BY a.created_at,a.id LIMIT ${limit}`;
}
export async function findPendingRefunds(prisma: PrismaClient, {limit}: {limit:number}): Promise<RefundJob[]> {
  return prisma.$queryRaw<RefundJob[]>`SELECT id AS "refundRequiredId" FROM refund_required WHERE status IN ('required','processing') ORDER BY created_at,id LIMIT ${limit}`;
}
export async function completeRefund(prisma: PrismaClient, refundRequiredId:string): Promise<'completed'|'noop'> {
  // Commit processing before simulating settlement, so a crashed worker leaves recoverable work.
  for (const phase of ['processing', 'refunded'] as const) {
    const result = await prisma.$transaction(async tx => {
      const [target] = await tx.$queryRaw<{holdId:string;screeningId:string}[]>`SELECT a.hold_id AS "holdId",h.screening_id AS "screeningId"
        FROM refund_required r JOIN payment_attempts a ON a.id=r.payment_attempt_id JOIN holds h ON h.id=a.hold_id WHERE r.id=${refundRequiredId}::uuid`;
      if (!target) return 'noop' as const;
      await tx.$queryRaw`SELECT id FROM screenings WHERE id=${target.screeningId}::uuid FOR KEY SHARE`;
      await tx.$queryRaw`SELECT id FROM holds WHERE id=${target.holdId}::uuid FOR NO KEY UPDATE`;
      const [refund] = await tx.$queryRaw<{status:string;paymentAttemptId:string;amountPaise:number}[]>`SELECT status,payment_attempt_id AS "paymentAttemptId",amount_paise AS "amountPaise" FROM refund_required WHERE id=${refundRequiredId}::uuid FOR UPDATE`;
      if (!refund || refund.status==='refunded') return 'noop' as const;
      if (phase === 'processing') {
        if (refund.status === 'required') await tx.$executeRaw`UPDATE refund_required SET status='processing' WHERE id=${refundRequiredId}::uuid`;
        return 'processing' as const;
      }
      await tx.$executeRaw`UPDATE refund_required SET status='refunded',refunded_at=now() WHERE id=${refundRequiredId}::uuid`;
      await emitPaymentEvent(tx,target.holdId,'refund.completed',{paymentAttemptId:refund.paymentAttemptId,amountPaise:refund.amountPaise},false);
      return 'completed' as const;
    }, {maxWait:30000,timeout:30000});
    if (result !== 'processing') return result;
  }
  return 'noop';
}
