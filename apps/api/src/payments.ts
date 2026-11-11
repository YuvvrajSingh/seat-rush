import { emitPaymentEvent, type SqlTransaction } from '@seatrush/db';
import { PaymentAttemptSchema, BookingSchema, type PaymentNotification, type StartPaymentRequest } from '@seatrush/shared';
import { HttpError } from './middleware/errors.js';

export async function getPayment(tx: SqlTransaction,id:string,customerId:string) {
  const [row]=await tx.$queryRaw<{value:unknown}[]>`SELECT jsonb_build_object('id',a.id,'holdId',a.hold_id,'status',a.status,'scenario',a.scenario,
    'amountPaise',a.amount_paise,'createdAt',a.created_at,'finalizedAt',a.finalized_at,'bookingId',b.id,
    'refund',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('status',r.status,'amountPaise',r.amount_paise,'reason',r.reason) END) AS value
    FROM payment_attempts a JOIN holds h ON h.id=a.hold_id LEFT JOIN bookings b ON b.payment_attempt_id=a.id
    LEFT JOIN refund_required r ON r.payment_attempt_id=a.id WHERE a.id=${id}::uuid AND h.customer_id=${customerId}::uuid`;
  if(!row) throw new HttpError(404,'not_found','Payment not found');
  const payment=PaymentAttemptSchema.parse(row.value);
  payment.createdAt=new Date(payment.createdAt).toISOString();
  if(payment.finalizedAt) payment.finalizedAt=new Date(payment.finalizedAt).toISOString();
  return payment;
}
export async function getBooking(tx:SqlTransaction,id:string,customerId:string) {
  const [row]=await tx.$queryRaw<{value:unknown}[]>`SELECT jsonb_build_object('id',b.id,'reference',b.reference,'amountPaise',b.amount_paise,'confirmedAt',b.confirmed_at,
    'screening',jsonb_build_object('id',sc.id,'title',sc.title,'startsAt',sc.starts_at,'durationMinutes',sc.duration_minutes),
    'tickets',(SELECT jsonb_agg(jsonb_build_object('seatId',s.id,'label',s.label,'ticketCode',bs.ticket_code,'pricePaise',bs.price_paise) ORDER BY s.row,s.number)
      FROM booked_seats bs JOIN seats s ON s.id=bs.seat_id WHERE bs.booking_id=b.id)) AS value
    FROM bookings b JOIN screenings sc ON sc.id=b.screening_id WHERE b.id=${id}::uuid AND b.customer_id=${customerId}::uuid`;
  if(!row) throw new HttpError(404,'not_found','Booking not found');
  const booking=BookingSchema.parse(row.value); booking.confirmedAt=new Date(booking.confirmedAt).toISOString(); booking.screening.startsAt=new Date(booking.screening.startsAt).toISOString(); return booking;
}
export async function startPayment(tx:SqlTransaction,holdId:string,customerId:string,request:StartPaymentRequest,store:(response:{status:number;body:unknown})=>Promise<void>) {
  await tx.$queryRaw`SELECT id FROM identities WHERE id=${customerId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM holds WHERE id=${holdId}::uuid AND customer_id=${customerId}::uuid FOR NO KEY UPDATE`;
  const [hold]=await tx.$queryRaw<{status:string;live:boolean}[]>`SELECT status,
    expires_at>now() AND NOT EXISTS (SELECT 1 FROM hold_items hi JOIN seats s ON s.id=hi.seat_id
      WHERE hi.hold_id=h.id AND s.current_hold_id IS DISTINCT FROM h.id) AS live
    FROM holds h WHERE id=${holdId}::uuid AND customer_id=${customerId}::uuid`;
  if(!hold) throw new HttpError(404,'not_found','Hold not found');
  if(hold.status==='confirmed') throw new HttpError(409,'already_confirmed','Hold is already confirmed');
  if(hold.status!=='active'||!hold.live) throw new HttpError(409,'hold_not_active','Hold is no longer active');
  const [pending]=await tx.$queryRaw<{id:string}[]>`SELECT id FROM payment_attempts WHERE hold_id=${holdId}::uuid AND status='initiated'`;
  if(pending) throw new HttpError(409,'payment_in_progress','A payment is already in progress');
  const [attempt]=await tx.$queryRaw<{id:string}[]>`INSERT INTO payment_attempts (hold_id,amount_paise,scenario,delay_ms)
    SELECT id,amount_paise,${request.scenario},${request.delayMs??10000} FROM holds WHERE id=${holdId}::uuid RETURNING id`;
  const body=await getPayment(tx,attempt!.id,customerId); const response={status:201,body}; await store(response);
  await emitPaymentEvent(tx,holdId,'payment.initiated',{paymentAttemptId:body.id}); return response;
}
export async function applyNotification(tx:SqlTransaction,n:PaymentNotification) {
  const [target]=await tx.$queryRaw<{holdId:string;screeningId:string;customerId:string}[]>`SELECT h.id AS "holdId",h.screening_id AS "screeningId",h.customer_id AS "customerId"
    FROM payment_attempts a JOIN holds h ON h.id=a.hold_id WHERE a.id=${n.paymentAttemptId}::uuid`;
  if(!target) throw new HttpError(404,'not_found','Payment not found');
  await tx.$queryRaw`SELECT id FROM screenings WHERE id=${target.screeningId}::uuid FOR KEY SHARE`;
  await tx.$queryRaw`SELECT id FROM identities WHERE id=${target.customerId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM holds WHERE id=${target.holdId}::uuid FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT s.id FROM seats s JOIN hold_items hi ON hi.seat_id=s.id WHERE hi.hold_id=${target.holdId}::uuid ORDER BY s.id FOR NO KEY UPDATE OF s`;
  const [hold]=await tx.$queryRaw<{status:string;live:boolean}[]>`SELECT status,
    expires_at>now() AND NOT EXISTS (SELECT 1 FROM hold_items hi JOIN seats s ON s.id=hi.seat_id
      WHERE hi.hold_id=h.id AND s.current_hold_id IS DISTINCT FROM h.id) AS live
    FROM holds h WHERE id=${target.holdId}::uuid`;
  const [attempt]=await tx.$queryRaw<{status:string;amount:number}[]>`SELECT status,amount_paise AS amount FROM payment_attempts WHERE id=${n.paymentAttemptId}::uuid FOR UPDATE`;
  if (!hold || !attempt) throw new HttpError(404,'not_found','Payment not found');
  const [event]=await tx.$queryRaw<{id:string}[]>`INSERT INTO payment_events (provider_event_id,payment_attempt_id,outcome,payload)
    VALUES (${n.providerEventId},${n.paymentAttemptId}::uuid,${n.outcome},${JSON.stringify(n)}::jsonb) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`;
  if(!event) {
    const [same]=await tx.$queryRaw<{id:string}[]>`SELECT id FROM payment_events WHERE provider_event_id=${n.providerEventId} AND payment_attempt_id=${n.paymentAttemptId}::uuid AND outcome=${n.outcome}`;
    if(!same) throw new HttpError(409,'idempotency_key_reused','Provider event ID reused with different payload');
    const [firstDuplicate] = await tx.$queryRaw<{id:string}[]>`UPDATE payment_events SET duplicate_event_emitted=true
      WHERE provider_event_id=${n.providerEventId} AND NOT duplicate_event_emitted RETURNING id`;
    if (firstDuplicate) await emitPaymentEvent(tx,target.holdId,'payment.notification_ignored',{paymentAttemptId:n.paymentAttemptId,reason:'duplicate'},false);
    return {disposition:'duplicate' as const};
  }
  const final=attempt!.status!=='initiated';
  await tx.$executeRaw`UPDATE payment_events SET disposition=${final?'ignored':'applied'},processed_at=now() WHERE id=${event.id}::uuid`;
  if(final) { await emitPaymentEvent(tx,target.holdId,'payment.notification_ignored',{paymentAttemptId:n.paymentAttemptId,reason:'already_final'},false); return {disposition:'ignored' as const}; }
  if(n.outcome==='processing') return {disposition:'applied' as const};
  await tx.$executeRaw`UPDATE payment_attempts SET status=${n.outcome},finalized_at=now() WHERE id=${n.paymentAttemptId}::uuid`;
  if(n.outcome==='failed') { await emitPaymentEvent(tx,target.holdId,'payment.failed',{paymentAttemptId:n.paymentAttemptId}); return {disposition:'applied' as const}; }
  if(hold!.status==='active'&&hold!.live) {
    await tx.$executeRaw`INSERT INTO bookings (hold_id,screening_id,customer_id,payment_attempt_id,amount_paise)
      VALUES (${target.holdId}::uuid,${target.screeningId}::uuid,${target.customerId}::uuid,${n.paymentAttemptId}::uuid,${attempt!.amount})`;
    return {disposition:'applied' as const};
  }
  const reason=hold!.status==='released'?'hold_released':'hold_expired';
  const [refund]=await tx.$queryRaw<{id:string}[]>`INSERT INTO refund_required (payment_attempt_id,amount_paise,reason) VALUES (${n.paymentAttemptId}::uuid,${attempt!.amount},${reason}) RETURNING id`;
  await emitPaymentEvent(tx,target.holdId,'refund.required',{paymentAttemptId:n.paymentAttemptId,amountPaise:attempt!.amount,reason});
  return {disposition:'applied' as const,refundRequiredId:refund!.id};
}
