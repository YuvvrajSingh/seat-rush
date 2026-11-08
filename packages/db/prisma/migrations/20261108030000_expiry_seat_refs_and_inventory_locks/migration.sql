-- Inventory writers change only ownership pointers, never seat keys. NO KEY UPDATE
-- keeps writers serialized without blocking hold-item/ticket foreign-key checks.
CREATE OR REPLACE FUNCTION claim_seats(p_screening_id uuid, p_customer_id uuid, p_seat_ids uuid[])
RETURNS SETOF holds LANGUAGE plpgsql AS $$
DECLARE n integer; claimed integer; price integer; h holds%ROWTYPE; conflicts jsonb;
BEGIN
  n := cardinality(p_seat_ids);
  IF n IS NULL OR n NOT BETWEEN 1 AND 4 OR n <> (SELECT count(DISTINCT id) FROM unnest(p_seat_ids) AS id) THEN
    RAISE EXCEPTION 'request must contain 1-4 distinct seats' USING ERRCODE = '22023';
  END IF;
  SELECT seat_price_paise INTO price FROM screenings WHERE id = p_screening_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening not found' USING ERRCODE = 'SR404'; END IF;
  PERFORM id FROM identities WHERE id = p_customer_id AND role = 'customer' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer not found' USING ERRCODE = 'SR401'; END IF;
  IF EXISTS (SELECT 1 FROM holds WHERE customer_id = p_customer_id AND screening_id = p_screening_id AND status = 'active' AND expires_at > now()) THEN
    RAISE EXCEPTION 'customer already has an active hold' USING ERRCODE = 'SR410';
  END IF;
  PERFORM old.id FROM holds old WHERE old.id IN (
    SELECT current_hold_id FROM seats WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids)
  ) ORDER BY old.id FOR NO KEY UPDATE;
  PERFORM id FROM seats WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids) ORDER BY id FOR NO KEY UPDATE;
  GET DIAGNOSTICS claimed = ROW_COUNT;
  IF claimed <> n THEN RAISE EXCEPTION 'unknown or foreign screening seat' USING ERRCODE = '22023'; END IF;
  SELECT jsonb_agg(s.id ORDER BY s.id) INTO conflicts FROM seats s LEFT JOIN holds old ON old.id = s.current_hold_id
    WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
      AND (EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.screening_id = s.screening_id AND bs.seat_id = s.id)
        OR (old.status = 'active' AND old.expires_at > now()));
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'seat conflict: %', conflicts USING ERRCODE = 'SR409', DETAIL = conflicts::text;
  END IF;
  INSERT INTO holds (screening_id, customer_id, seat_count, amount_paise)
    VALUES (p_screening_id, p_customer_id, n, price * n) RETURNING * INTO h;
  INSERT INTO hold_items (hold_id, seat_id, screening_id, price_paise)
    SELECT h.id, id, p_screening_id, price FROM seats WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids);
  WITH claimed_seats AS (
    UPDATE seats s SET current_hold_id = h.id
      WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
        AND NOT EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.screening_id = s.screening_id AND bs.seat_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM holds old WHERE old.id = s.current_hold_id AND old.status = 'active' AND old.expires_at > now())
      RETURNING s.id
  ) SELECT count(*) INTO claimed FROM claimed_seats;
  IF claimed <> n THEN RAISE EXCEPTION 'seat conflict' USING ERRCODE = 'SR409'; END IF;
  RETURN NEXT h;
END $$;

-- Return types cannot be changed with CREATE OR REPLACE. No SQL function calls
-- this helper; application callers now consume the actual cleared seat rows.
DROP FUNCTION cleanup_expired_hold(uuid);
CREATE FUNCTION cleanup_expired_hold(p_hold_id uuid)
RETURNS TABLE(id uuid, label text) LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE;
BEGIN
  PERFORM lock_hold_screening(p_hold_id);
  SELECT old.* INTO h FROM holds old WHERE old.id = p_hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.status <> 'active' OR h.expires_at > now() THEN RETURN; END IF;
  PERFORM s.id FROM seats s WHERE s.current_hold_id = p_hold_id ORDER BY s.id FOR NO KEY UPDATE;
  UPDATE holds old SET status = 'expired' WHERE old.id = p_hold_id;
  -- Historical hold_items may include seats already reclaimed by newer owners.
  -- Only UPDATE RETURNING defines this cleanup's outbox payload.
  RETURN QUERY
    WITH cleared AS (
      UPDATE seats s SET current_hold_id = NULL WHERE s.current_hold_id = p_hold_id
      RETURNING s.id, s.label, s.row, s.number
    )
    SELECT cleared.id, cleared.label FROM cleared ORDER BY cleared.row, cleared.number;
END $$;

CREATE OR REPLACE FUNCTION release_hold(p_hold_id uuid, p_customer_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE; cleared integer;
BEGIN
  PERFORM lock_hold_screening(p_hold_id);
  SELECT * INTO h FROM holds WHERE id = p_hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.customer_id <> p_customer_id THEN RAISE EXCEPTION 'hold not found' USING ERRCODE = '22023'; END IF;
  IF h.status <> 'active' THEN RETURN 0; END IF;
  PERFORM id FROM seats WHERE current_hold_id = p_hold_id ORDER BY id FOR NO KEY UPDATE;
  UPDATE holds SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'released' END WHERE id = p_hold_id;
  UPDATE seats SET current_hold_id = NULL WHERE current_hold_id = p_hold_id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END $$;

CREATE OR REPLACE FUNCTION prepare_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE;
BEGIN
  PERFORM lock_hold_screening(NEW.hold_id);
  SELECT * INTO h FROM holds WHERE id = NEW.hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.status <> 'active' OR h.expires_at <= now() OR NEW.amount_paise <> h.amount_paise THEN
    RAISE EXCEPTION 'booking requires a valid hold' USING ERRCODE = '23514';
  END IF;
  PERFORM s.id FROM seats s JOIN hold_items hi ON hi.seat_id = s.id WHERE hi.hold_id = h.id ORDER BY s.id FOR NO KEY UPDATE OF s;
  PERFORM assert_hold_integrity(h.id);
  IF NOT EXISTS (SELECT 1 FROM payment_attempts WHERE id = NEW.payment_attempt_id AND hold_id = h.id AND status = 'succeeded' AND amount_paise = h.amount_paise)
    OR EXISTS (SELECT 1 FROM refund_required WHERE payment_attempt_id = NEW.payment_attempt_id) THEN
    RAISE EXCEPTION 'booking requires unrefunded successful payment for its full amount' USING ERRCODE = '23514';
  END IF;
  UPDATE holds SET status = 'confirmed' WHERE id = h.id;
  UPDATE seats SET current_hold_id = NULL WHERE current_hold_id = h.id;
  RETURN NEW;
END $$;

-- Ticket insertion participates in confirmation too: do not upgrade the seat
-- lock after prepare_booking has already locked the inventory in ID order.
CREATE OR REPLACE FUNCTION guard_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM seats WHERE id = NEW.seat_id FOR NO KEY UPDATE;
  IF NOT EXISTS (SELECT 1 FROM bookings b JOIN hold_items hi ON hi.hold_id = b.hold_id
    WHERE b.id = NEW.booking_id AND hi.seat_id = NEW.seat_id AND hi.price_paise = NEW.price_paise)
    OR EXISTS (SELECT 1 FROM seats s JOIN holds h ON h.id = s.current_hold_id
      WHERE s.id = NEW.seat_id AND h.status = 'active' AND h.expires_at > now()) THEN
    RAISE EXCEPTION 'ticket must match its booking without an active owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
