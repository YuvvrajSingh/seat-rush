-- Reset must remove conflict observations and legacy unassociated hold responses before
-- deleting the holds needed to recover their screening. Opaque request hashes cannot be
-- reversed; records without an association or recoverable response remain retained.
CREATE OR REPLACE FUNCTION reset_demo_screening(p_screening_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous_setting text;
BEGIN
  PERFORM id FROM screenings WHERE id = p_screening_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening not found' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM simulation_runs WHERE screening_id = p_screening_id AND status IN ('pending', 'running')) THEN
    RAISE EXCEPTION 'cannot reset during an active simulation' USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM holds WHERE screening_id = p_screening_id ORDER BY id FOR NO KEY UPDATE;
  PERFORM id FROM seats WHERE screening_id = p_screening_id ORDER BY id FOR UPDATE;
  previous_setting := current_setting('seatrush.reset', true);
  PERFORM set_config('seatrush.reset', 'on', true);
  UPDATE seats SET current_hold_id = NULL WHERE screening_id = p_screening_id;
  DELETE FROM domain_events WHERE screening_id = p_screening_id;
  DELETE FROM conflict_windows WHERE screening_id = p_screening_id;
  DELETE FROM idempotency_records r
    WHERE r.screening_id = p_screening_id
      OR (r.screening_id IS NULL AND (
        r.response_body ->> 'screeningId' = p_screening_id::text
        OR EXISTS (
          SELECT 1 FROM holds h WHERE h.screening_id = p_screening_id AND h.customer_id = r.customer_id
            AND (h.id::text = r.response_body ->> 'id' OR h.id::text = r.response_body ->> 'holdId')
        )
      ));
  DELETE FROM refund_required WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN holds h ON h.id = a.hold_id WHERE h.screening_id = p_screening_id);
  DELETE FROM payment_events WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN holds h ON h.id = a.hold_id WHERE h.screening_id = p_screening_id);
  DELETE FROM booked_seats WHERE screening_id = p_screening_id;
  DELETE FROM bookings WHERE screening_id = p_screening_id;
  DELETE FROM payment_attempts WHERE hold_id IN (SELECT id FROM holds WHERE screening_id = p_screening_id);
  DELETE FROM hold_items WHERE screening_id = p_screening_id;
  DELETE FROM holds WHERE screening_id = p_screening_id;
  -- Preserve the monotonic event cursor, screening, seats and simulation-run history.
  PERFORM set_config('seatrush.reset', coalesce(previous_setting, ''), true);
END $$;
