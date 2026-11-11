-- Retained history must remain readable by the strict current event schema.
UPDATE domain_events e SET payload = e.payload || jsonb_build_object('expiresAt', h.expires_at)
FROM holds h WHERE e.kind IN ('hold.released','hold.expired') AND e.payload->>'holdId'=h.id::text;
UPDATE domain_events e SET customer_id=b.customer_id,
  payload=jsonb_build_object('id',e.id::text,'at',e.payload->>'at','kind','booking.confirmed',
    'screeningId',b.screening_id,'holdId',b.hold_id,'bookingId',b.id,'paymentAttemptId',b.payment_attempt_id,'amountPaise',b.amount_paise,
    'seats',(SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',s.label) ORDER BY s.row,s.number)
      FROM booked_seats bs JOIN seats s ON s.id=bs.seat_id WHERE bs.booking_id=b.id))
FROM bookings b WHERE e.booking_id=b.id AND e.kind='booking.confirmed';
-- Previously completed hold responses predate the owner-only payment locator.
UPDATE idempotency_records SET response_body=response_body || '{"latestPaymentAttemptId":null}'::jsonb
WHERE status='completed' AND response_code BETWEEN 200 AND 299 AND operation IN ('hold.create','hold.release')
  AND NOT response_body ? 'latestPaymentAttemptId';
