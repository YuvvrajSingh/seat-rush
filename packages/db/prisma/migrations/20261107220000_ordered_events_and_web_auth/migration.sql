-- Event cursors survive reset. Lock order: screening, customer, holds, seats, then cursor.
CREATE TABLE screening_event_cursors (
  screening_id uuid PRIMARY KEY REFERENCES screenings(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  last_event_id bigint NOT NULL DEFAULT 0 CHECK (last_event_id >= 0)
);
INSERT INTO screening_event_cursors (screening_id, last_event_id)
  SELECT s.id, coalesce(max(e.id), 0) FROM screenings s LEFT JOIN domain_events e ON e.screening_id = s.id GROUP BY s.id;
CREATE FUNCTION initialize_screening_event_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO screening_event_cursors (screening_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER screenings_event_cursor AFTER INSERT ON screenings
  FOR EACH ROW EXECUTE FUNCTION initialize_screening_event_cursor();

-- Attribution is an immutable historical UUID, not an ownership FK requiring a later identity lock.
ALTER TABLE domain_events ADD COLUMN customer_id uuid;
UPDATE domain_events SET customer_id = (payload ->> 'customerId')::uuid WHERE payload ? 'customerId';
UPDATE domain_events SET payload = payload - 'customerId' WHERE payload ? 'customerId';
UPDATE domain_events SET payload = payload - 'expiresAt' WHERE kind IN ('hold.released', 'hold.expired');
CREATE INDEX domain_events_screening_id_id_idx ON domain_events(screening_id, id);

-- The default sequence may have consumed a value before entering this trigger; deliberately
-- allocate the authoritative id only AFTER the cursor lock. Gaps are harmless, inversion is not.
-- This guard also covers booking events and direct SQL writers, not only HTTP callers.
CREATE FUNCTION serialize_screening_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM screening_id FROM screening_event_cursors WHERE screening_id = NEW.screening_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening event cursor missing' USING ERRCODE = '23503'; END IF;
  NEW.id := nextval(pg_get_serial_sequence('domain_events', 'id'));
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());
  NEW.payload := NEW.payload || jsonb_build_object('id', NEW.id::text,
    'at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE screening_event_cursors SET last_event_id = NEW.id WHERE screening_id = NEW.screening_id;
  RETURN NEW;
END $$;
CREATE TRIGGER domain_events_commit_order BEFORE INSERT ON domain_events
  FOR EACH ROW EXECUTE FUNCTION serialize_screening_event();

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
