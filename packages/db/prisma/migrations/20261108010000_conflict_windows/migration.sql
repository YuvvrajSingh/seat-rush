-- Rejections are observations, not ownership changes: keep them out of domain_events.
CREATE TABLE "conflict_windows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "screening_id" UUID NOT NULL,
    "seat_id" UUID NOT NULL,
    "count" INTEGER NOT NULL,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "window_ended_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),

    CONSTRAINT "conflict_windows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conflict_windows_count_positive" CHECK ("count" > 0),
    CONSTRAINT "conflict_windows_interval_ordered" CHECK ("window_ended_at" >= "window_started_at"),
    CONSTRAINT "conflict_windows_seat_id_screening_id_fkey"
      FOREIGN KEY ("seat_id", "screening_id") REFERENCES "seats"("id", "screening_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "conflict_windows_screening_id_window_started_at_idx"
  ON "conflict_windows"("screening_id", "window_started_at");

-- A controlled 4xx for a missing resource still needs a durable idempotent response.
ALTER TABLE "idempotency_records" ALTER COLUMN "screening_id" DROP NOT NULL;
