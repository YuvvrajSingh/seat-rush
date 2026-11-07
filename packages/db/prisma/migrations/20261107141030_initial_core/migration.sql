-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "demo_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "demo_key" TEXT,
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "seat_price_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "screening_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "current_hold_id" UUID,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "screening_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "seat_count" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:05:00'::interval),

    CONSTRAINT "holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hold_items" (
    "hold_id" UUID NOT NULL,
    "seat_id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "price_paise" INTEGER NOT NULL,

    CONSTRAINT "hold_items_pkey" PRIMARY KEY ("hold_id","seat_id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL DEFAULT ('SR-'::text || upper(replace((gen_random_uuid())::text, '-'::text, ''::text))),
    "hold_id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booked_seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "seat_id" UUID NOT NULL,
    "ticket_code" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "price_paise" INTEGER NOT NULL,

    CONSTRAINT "booked_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hold_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "amount_paise" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_event_id" TEXT NOT NULL,
    "payment_attempt_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "disposition" TEXT NOT NULL DEFAULT 'pending',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_required" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_attempt_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'required',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refunded_at" TIMESTAMPTZ(6),

    CONSTRAINT "refund_required_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:00:30'::interval),
    "retain_until" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '24:00:00'::interval),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "screening_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "config" JSONB NOT NULL,
    "results" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "simulation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" BIGSERIAL NOT NULL,
    "screening_id" UUID NOT NULL,
    "booking_id" UUID,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identities_demo_key_key" ON "identities"("demo_key");

-- CreateIndex
CREATE UNIQUE INDEX "screenings_demo_key_key" ON "screenings"("demo_key");

-- CreateIndex
CREATE INDEX "seats_current_hold_id_idx" ON "seats"("current_hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "seats_screening_id_label_key" ON "seats"("screening_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "seats_screening_id_row_number_key" ON "seats"("screening_id", "row", "number");

-- CreateIndex
CREATE UNIQUE INDEX "seats_id_screening_id_key" ON "seats"("id", "screening_id");

-- CreateIndex
CREATE INDEX "holds_status_expires_at_idx" ON "holds"("status", "expires_at");

-- CreateIndex
CREATE INDEX "holds_customer_id_idx" ON "holds"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "holds_id_screening_id_key" ON "holds"("id", "screening_id");

-- CreateIndex
CREATE UNIQUE INDEX "holds_id_screening_id_customer_id_key" ON "holds"("id", "screening_id", "customer_id");

-- CreateIndex
CREATE INDEX "hold_items_seat_id_idx" ON "hold_items"("seat_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_hold_id_key" ON "bookings"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_payment_attempt_id_key" ON "bookings"("payment_attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_id_screening_id_key" ON "bookings"("id", "screening_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_hold_id_screening_id_customer_id_key" ON "bookings"("hold_id", "screening_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_payment_attempt_id_hold_id_key" ON "bookings"("payment_attempt_id", "hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "booked_seats_ticket_code_key" ON "booked_seats"("ticket_code");

-- CreateIndex
CREATE UNIQUE INDEX "booked_seats_screening_id_seat_id_key" ON "booked_seats"("screening_id", "seat_id");

-- CreateIndex
CREATE INDEX "payment_attempts_hold_id_idx" ON "payment_attempts"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_id_hold_id_key" ON "payment_attempts"("id", "hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "payment_events_payment_attempt_id_received_at_idx" ON "payment_events"("payment_attempt_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "refund_required_payment_attempt_id_key" ON "refund_required"("payment_attempt_id");

-- CreateIndex
CREATE INDEX "idempotency_records_retain_until_idx" ON "idempotency_records"("retain_until");

-- CreateIndex
CREATE INDEX "idempotency_records_screening_id_idx" ON "idempotency_records"("screening_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_customer_id_operation_key_key" ON "idempotency_records"("customer_id", "operation", "key");

-- CreateIndex
CREATE INDEX "domain_events_published_at_id_idx" ON "domain_events"("published_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_events_booking_id_kind_key" ON "domain_events"("booking_id", "kind");

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_current_hold_id_screening_id_fkey" FOREIGN KEY ("current_hold_id", "screening_id") REFERENCES "holds"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "hold_items" ADD CONSTRAINT "hold_items_hold_id_screening_id_fkey" FOREIGN KEY ("hold_id", "screening_id") REFERENCES "holds"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "hold_items" ADD CONSTRAINT "hold_items_seat_id_screening_id_fkey" FOREIGN KEY ("seat_id", "screening_id") REFERENCES "seats"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_hold_id_screening_id_customer_id_fkey" FOREIGN KEY ("hold_id", "screening_id", "customer_id") REFERENCES "holds"("id", "screening_id", "customer_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_payment_attempt_id_hold_id_fkey" FOREIGN KEY ("payment_attempt_id", "hold_id") REFERENCES "payment_attempts"("id", "hold_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booked_seats" ADD CONSTRAINT "booked_seats_booking_id_screening_id_fkey" FOREIGN KEY ("booking_id", "screening_id") REFERENCES "bookings"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booked_seats" ADD CONSTRAINT "booked_seats_seat_id_screening_id_fkey" FOREIGN KEY ("seat_id", "screening_id") REFERENCES "seats"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "holds"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refund_required" ADD CONSTRAINT "refund_required_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "screenings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_booking_id_screening_id_fkey" FOREIGN KEY ("booking_id", "screening_id") REFERENCES "bookings"("id", "screening_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written concurrency rules. Time is a range, not an index predicate using now().
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE identities ADD CONSTRAINT identities_role_check CHECK (role IN ('customer', 'operator'));
ALTER TABLE screenings ADD CONSTRAINT screenings_values_check
  CHECK (duration_minutes = 180 AND seat_price_paise > 0);
ALTER TABLE seats ADD CONSTRAINT seats_label_check
  CHECK (row ~ '^[A-J]$' AND number BETWEEN 1 AND 10 AND label = row || number::text);
ALTER TABLE holds ADD CONSTRAINT holds_values_check
  CHECK (status IN ('active', 'released', 'expired', 'confirmed')
    AND seat_count BETWEEN 1 AND 4 AND amount_paise > 0
    AND expires_at = created_at + interval '5 minutes');
ALTER TABLE holds ADD CONSTRAINT holds_one_active_customer
  EXCLUDE USING gist (customer_id WITH =, screening_id WITH =,
    tstzrange(created_at, expires_at, '[)') WITH &&) WHERE (status = 'active');
ALTER TABLE hold_items ADD CONSTRAINT hold_items_price_check CHECK (price_paise > 0);
ALTER TABLE bookings ADD CONSTRAINT bookings_amount_check CHECK (amount_paise > 0);
ALTER TABLE booked_seats ADD CONSTRAINT booked_seats_price_check CHECK (price_paise > 0);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_state_check
  CHECK (amount_paise > 0 AND
    ((status = 'initiated' AND finalized_at IS NULL)
      OR (status IN ('succeeded', 'failed') AND finalized_at IS NOT NULL)));
CREATE UNIQUE INDEX payment_attempts_one_unresolved ON payment_attempts (hold_id) WHERE status = 'initiated';
ALTER TABLE payment_events ADD CONSTRAINT payment_events_values_check
  CHECK (outcome IN ('succeeded', 'failed') AND disposition IN ('pending', 'applied', 'ignored'));
ALTER TABLE refund_required ADD CONSTRAINT refund_required_values_check
  CHECK (amount_paise > 0 AND status IN ('required', 'processing', 'refunded')
    AND (status = 'refunded') = (refunded_at IS NOT NULL));
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_values_check
  CHECK (length(key) > 0 AND length(operation) > 0 AND length(request_hash) > 0
    AND retain_until >= created_at + interval '24 hours'
    AND ((status = 'in_progress' AND response_code IS NULL AND response_body IS NULL)
      OR (status = 'completed' AND (response_code BETWEEN 200 AND 299 OR response_code BETWEEN 400 AND 499) AND response_body IS NOT NULL)));
ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_state_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

CREATE FUNCTION guard_payment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'initiated' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'final payment attempt is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.hold_id <> OLD.hold_id OR NEW.amount_paise <> OLD.amount_paise THEN
    RAISE EXCEPTION 'payment identity and amount are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_absorbing BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_payment_transition();

-- Locking a seat is the serialization point shared by claims and confirmations.
CREATE FUNCTION guard_seat_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_hold_id IS NOT NULL AND NEW.current_hold_id IS DISTINCT FROM OLD.current_hold_id THEN
    IF EXISTS (SELECT 1 FROM booked_seats WHERE screening_id = NEW.screening_id AND seat_id = NEW.id)
      OR EXISTS (SELECT 1 FROM holds WHERE id = OLD.current_hold_id AND status = 'active' AND expires_at > now())
      OR NOT EXISTS (SELECT 1 FROM holds WHERE id = NEW.current_hold_id
        AND screening_id = NEW.screening_id AND status = 'active' AND expires_at > now()) THEN
      RAISE EXCEPTION 'seat ownership conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seats_guard_owner BEFORE INSERT OR UPDATE OF current_hold_id ON seats
  FOR EACH ROW EXECUTE FUNCTION guard_seat_owner();

-- Deferred checks make a multi-seat claim indivisible even for direct SQL writers.
CREATE FUNCTION assert_hold_integrity(p_hold_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE; item_count bigint; total bigint;
BEGIN
  SELECT * INTO h FROM holds WHERE id = p_hold_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), coalesce(sum(price_paise), 0) INTO item_count, total FROM hold_items WHERE hold_id = h.id;
  IF item_count <> h.seat_count OR total <> h.amount_paise THEN
    RAISE EXCEPTION 'hold items or amount mismatch' USING ERRCODE = '23514';
  END IF;
  IF h.status = 'active' AND h.expires_at > now() AND EXISTS (
    SELECT 1 FROM hold_items hi JOIN seats s ON s.id = hi.seat_id
    WHERE hi.hold_id = h.id AND (s.current_hold_id IS DISTINCT FROM h.id
      OR EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id AND bs.screening_id = s.screening_id))
  ) THEN
    RAISE EXCEPTION 'active hold does not exclusively own all its seats' USING ERRCODE = '23514';
  END IF;
  IF h.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM bookings WHERE hold_id = h.id) THEN
    RAISE EXCEPTION 'confirmed hold requires a booking' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION check_hold_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN PERFORM assert_hold_integrity(NEW.id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER holds_integrity AFTER INSERT OR UPDATE ON holds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_hold_row();

CREATE FUNCTION check_hold_item_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM assert_hold_integrity(OLD.hold_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM assert_hold_integrity(NEW.hold_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hold_items_integrity AFTER INSERT OR UPDATE OR DELETE ON hold_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_hold_item_row();

CREATE FUNCTION check_seat_hold_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_hold_id IS NOT NULL THEN PERFORM assert_hold_integrity(OLD.current_hold_id); END IF;
  IF NEW.current_hold_id IS NOT NULL THEN
    PERFORM assert_hold_integrity(NEW.current_hold_id);
    IF NOT EXISTS (SELECT 1 FROM hold_items WHERE hold_id = NEW.current_hold_id AND seat_id = NEW.id) THEN
      RAISE EXCEPTION 'seat owner requires a hold item' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER seats_hold_integrity AFTER INSERT OR UPDATE ON seats
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_seat_hold_row();

CREATE FUNCTION claim_seats(p_screening_id uuid, p_customer_id uuid, p_seat_ids uuid[])
RETURNS SETOF holds LANGUAGE plpgsql AS $$
DECLARE n integer; claimed integer; price integer; h holds%ROWTYPE;
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
  SELECT count(*) INTO claimed FROM seats s LEFT JOIN holds old ON old.id = s.current_hold_id
    WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
      AND NOT EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.screening_id = s.screening_id AND bs.seat_id = s.id)
      AND (old.id IS NULL OR old.status <> 'active' OR old.expires_at <= now());
  IF claimed <> n THEN RAISE EXCEPTION 'seat conflict' USING ERRCODE = 'SR409'; END IF;
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

CREATE FUNCTION prepare_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE;
BEGIN
  PERFORM lock_hold_screening(NEW.hold_id);
  SELECT * INTO h FROM holds WHERE id = NEW.hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.status <> 'active' OR h.expires_at <= now() OR NEW.amount_paise <> h.amount_paise THEN
    RAISE EXCEPTION 'booking requires a valid hold' USING ERRCODE = '23514';
  END IF;
  PERFORM s.id FROM seats s JOIN hold_items hi ON hi.seat_id = s.id WHERE hi.hold_id = h.id ORDER BY s.id FOR UPDATE OF s;
  PERFORM assert_hold_integrity(h.id);
  IF NOT EXISTS (SELECT 1 FROM payment_attempts WHERE id = NEW.payment_attempt_id AND hold_id = h.id AND status = 'succeeded' AND amount_paise = h.amount_paise)
    OR EXISTS (SELECT 1 FROM refund_required WHERE payment_attempt_id = NEW.payment_attempt_id) THEN
    RAISE EXCEPTION 'booking requires unrefunded successful payment for its full amount' USING ERRCODE = '23514';
  END IF;
  UPDATE holds SET status = 'confirmed' WHERE id = h.id;
  UPDATE seats SET current_hold_id = NULL WHERE current_hold_id = h.id;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_prepare BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION prepare_booking();

CREATE FUNCTION emit_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO booked_seats (booking_id, screening_id, seat_id, price_paise)
    SELECT NEW.id, NEW.screening_id, seat_id, price_paise FROM hold_items WHERE hold_id = NEW.hold_id;
  INSERT INTO domain_events (screening_id, booking_id, kind, payload)
    VALUES (NEW.screening_id, NEW.id, 'booking.confirmed',
      jsonb_build_object('bookingId', NEW.id, 'holdId', NEW.hold_id, 'amountPaise', NEW.amount_paise));
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_emit AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION emit_booking();

CREATE FUNCTION reject_confirmed_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('seatrush.reset', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'confirmed bookings and tickets are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER bookings_immutable BEFORE UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION reject_confirmed_change();
CREATE TRIGGER booked_seats_immutable BEFORE UPDATE OR DELETE ON booked_seats
  FOR EACH ROW EXECUTE FUNCTION reject_confirmed_change();

-- Direct inserts must belong to the original, validly confirmed hold.
CREATE FUNCTION guard_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM seats WHERE id = NEW.seat_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM bookings b JOIN hold_items hi ON hi.hold_id = b.hold_id
    WHERE b.id = NEW.booking_id AND hi.seat_id = NEW.seat_id AND hi.price_paise = NEW.price_paise)
    OR EXISTS (SELECT 1 FROM seats s JOIN holds h ON h.id = s.current_hold_id
      WHERE s.id = NEW.seat_id AND h.status = 'active' AND h.expires_at > now()) THEN
    RAISE EXCEPTION 'ticket must match its booking without an active owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booked_seats_guard BEFORE INSERT ON booked_seats FOR EACH ROW EXECUTE FUNCTION guard_ticket();

-- Global order: screening KEY SHARE, optional customer NO KEY UPDATE, holds by id,
-- then seats by id. Reset alone takes the screening FOR UPDATE.
CREATE FUNCTION lock_hold_screening(p_hold_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
  SELECT screening_id INTO sid FROM holds WHERE id = p_hold_id;
  PERFORM id FROM screenings WHERE id = sid FOR KEY SHARE;
END $$;

CREATE FUNCTION guard_hold_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.expires_at := now() + interval '5 minutes';
  ELSIF NEW.created_at > OLD.created_at OR NEW.expires_at > OLD.expires_at
    OR (NEW.id, NEW.screening_id, NEW.customer_id, NEW.seat_count, NEW.amount_paise)
      IS DISTINCT FROM (OLD.id, OLD.screening_id, OLD.customer_id, OLD.seat_count, OLD.amount_paise) THEN
    RAISE EXCEPTION 'hold identity, price and deadline cannot be extended or changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER holds_clock BEFORE INSERT OR UPDATE ON holds FOR EACH ROW EXECUTE FUNCTION guard_hold_clock();

CREATE FUNCTION guard_initial_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE;
BEGIN
  PERFORM lock_hold_screening(NEW.hold_id);
  SELECT * INTO h FROM holds WHERE id = NEW.hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NEW.status <> 'initiated' OR h.status <> 'active' OR h.expires_at <= now()
    OR h.amount_paise <> NEW.amount_paise
    OR EXISTS (SELECT 1 FROM payment_attempts WHERE hold_id = h.id AND status = 'succeeded') THEN
    RAISE EXCEPTION 'payment must start initiated for a valid unpaid hold amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_initial BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_initial_payment();
CREATE UNIQUE INDEX payment_attempts_one_succeeded ON payment_attempts (hold_id) WHERE status = 'succeeded';

CREATE FUNCTION guard_refund_required() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a payment_attempts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  PERFORM lock_hold_screening(a.hold_id);
  PERFORM id FROM holds WHERE id = a.hold_id FOR NO KEY UPDATE;
  SELECT * INTO a FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  IF NOT FOUND OR a.status <> 'succeeded' OR a.amount_paise <> NEW.amount_paise
    OR EXISTS (SELECT 1 FROM bookings WHERE payment_attempt_id = a.id) THEN
    RAISE EXCEPTION 'refund requires an unbooked successful attempt for its full amount' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.payment_attempt_id, NEW.amount_paise) IS DISTINCT FROM (OLD.payment_attempt_id, OLD.amount_paise) THEN
    RAISE EXCEPTION 'refund identity and amount are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_required_guard BEFORE INSERT OR UPDATE ON refund_required FOR EACH ROW EXECUTE FUNCTION guard_refund_required();

CREATE FUNCTION cleanup_expired_hold(p_hold_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE; cleared integer;
BEGIN
  PERFORM lock_hold_screening(p_hold_id);
  SELECT * INTO h FROM holds WHERE id = p_hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.status <> 'active' OR h.expires_at > now() THEN RETURN 0; END IF;
  PERFORM id FROM seats WHERE current_hold_id = p_hold_id ORDER BY id FOR UPDATE;
  UPDATE holds SET status = 'expired' WHERE id = p_hold_id;
  UPDATE seats SET current_hold_id = NULL WHERE current_hold_id = p_hold_id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END $$;

CREATE FUNCTION release_hold(p_hold_id uuid, p_customer_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE h holds%ROWTYPE; cleared integer;
BEGIN
  PERFORM lock_hold_screening(p_hold_id);
  SELECT * INTO h FROM holds WHERE id = p_hold_id FOR NO KEY UPDATE;
  IF NOT FOUND OR h.customer_id <> p_customer_id THEN RAISE EXCEPTION 'hold not found' USING ERRCODE = '22023'; END IF;
  IF h.status <> 'active' THEN RETURN 0; END IF;
  PERFORM id FROM seats WHERE current_hold_id = p_hold_id ORDER BY id FOR UPDATE;
  UPDATE holds SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'released' END WHERE id = p_hold_id;
  UPDATE seats SET current_hold_id = NULL WHERE current_hold_id = p_hold_id;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END $$;

CREATE FUNCTION guard_simulation_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM screenings WHERE id = NEW.screening_id FOR KEY SHARE;
  RETURN NEW;
END $$;
CREATE TRIGGER simulation_runs_screening_lock BEFORE INSERT OR UPDATE ON simulation_runs
  FOR EACH ROW EXECUTE FUNCTION guard_simulation_start();

CREATE FUNCTION reset_demo_screening(p_screening_id uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  DELETE FROM refund_required WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN holds h ON h.id = a.hold_id WHERE h.screening_id = p_screening_id);
  DELETE FROM payment_events WHERE payment_attempt_id IN (SELECT a.id FROM payment_attempts a JOIN holds h ON h.id = a.hold_id WHERE h.screening_id = p_screening_id);
  DELETE FROM booked_seats WHERE screening_id = p_screening_id;
  DELETE FROM bookings WHERE screening_id = p_screening_id;
  DELETE FROM payment_attempts WHERE hold_id IN (SELECT id FROM holds WHERE screening_id = p_screening_id);
  DELETE FROM hold_items WHERE screening_id = p_screening_id;
  DELETE FROM holds WHERE screening_id = p_screening_id;
  DELETE FROM idempotency_records WHERE screening_id = p_screening_id;
  PERFORM set_config('seatrush.reset', coalesce(previous_setting, ''), true);
END $$;
