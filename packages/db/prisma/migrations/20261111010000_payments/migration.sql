ALTER TABLE payment_attempts ADD COLUMN scenario text NOT NULL DEFAULT 'success', ADD COLUMN delay_ms integer NOT NULL DEFAULT 10000;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_scenario_check CHECK (scenario IN ('success','failure','delayed_success','duplicate_success','out_of_order','delivery_failure') AND delay_ms BETWEEN 0 AND 360000);
ALTER TABLE payment_events DROP CONSTRAINT payment_events_values_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_values_check CHECK (outcome IN ('processing','succeeded','failed') AND disposition IN ('pending','applied','ignored'));
-- Existing experimental refund reasons normalize to the public contract.
UPDATE refund_required SET reason = CASE WHEN reason = 'hold_released' THEN reason ELSE 'hold_expired' END;
ALTER TABLE refund_required ADD CONSTRAINT refund_reason_check CHECK (reason IN ('hold_expired','hold_released'));
CREATE OR REPLACE FUNCTION emit_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO booked_seats (booking_id, screening_id, seat_id, price_paise)
    SELECT NEW.id, NEW.screening_id, seat_id, price_paise FROM hold_items WHERE hold_id = NEW.hold_id;
  INSERT INTO domain_events (screening_id, booking_id, customer_id, kind, payload)
    VALUES (NEW.screening_id, NEW.id, NEW.customer_id, 'booking.confirmed',
      jsonb_build_object('kind','booking.confirmed','screeningId',NEW.screening_id,
        'bookingId',NEW.id,'holdId',NEW.hold_id,'paymentAttemptId',NEW.payment_attempt_id,'amountPaise',NEW.amount_paise,
        'seats',(SELECT jsonb_agg(jsonb_build_object('id',s.id,'label',s.label) ORDER BY s.row,s.number)
          FROM hold_items hi JOIN seats s ON s.id=hi.seat_id WHERE hi.hold_id=NEW.hold_id)));
  RETURN NEW;
END $$;
