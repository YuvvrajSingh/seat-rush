-- Keep the conflict set from the deciding, locked database read. Prisma's pg adapter may discard
-- PostgreSQL DETAIL, so the same structured set is also carried in the exception message.
CREATE OR REPLACE FUNCTION claim_seats(p_screening_id uuid, p_customer_id uuid, p_seat_ids uuid[])
RETURNS SETOF holds LANGUAGE plpgsql AS $$
DECLARE n integer; claimed integer; price integer; h holds%ROWTYPE; conflicts jsonb;
BEGIN
  n := cardinality(p_seat_ids);
  IF n IS NULL OR n NOT BETWEEN 1 AND 4 OR n <> (SELECT count(DISTINCT id) FROM unnest(p_seat_ids) AS id) THEN
    RAISE EXCEPTION 'request must contain 1-4 distinct seats' USING ERRCODE = '22023';
  END IF;
  SELECT seat_price_paise INTO price FROM screenings WHERE id = p_screening_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening not found' USING ERRCODE = '22023'; END IF;
  PERFORM id FROM identities WHERE id = p_customer_id AND role = 'customer' FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer not found' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM holds WHERE customer_id = p_customer_id AND screening_id = p_screening_id AND status = 'active' AND expires_at > now()) THEN
    RAISE EXCEPTION 'customer already has an active hold' USING ERRCODE = 'SR410';
  END IF;
  PERFORM old.id FROM holds old WHERE old.id IN (
    SELECT current_hold_id FROM seats WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids)
  ) ORDER BY old.id FOR NO KEY UPDATE;
  PERFORM id FROM seats WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids) ORDER BY id FOR UPDATE;
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
