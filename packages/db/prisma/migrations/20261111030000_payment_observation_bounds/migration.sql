ALTER TABLE payment_events ADD COLUMN duplicate_event_emitted boolean NOT NULL DEFAULT false;
CREATE INDEX payment_attempts_hold_id_created_at_id_idx ON payment_attempts (hold_id, created_at DESC, id DESC);
