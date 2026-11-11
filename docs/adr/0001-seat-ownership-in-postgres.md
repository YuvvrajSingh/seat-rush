# ADR 0001: Seat ownership lives in PostgreSQL

## Context

FR-02 requires all-or-nothing holds of 1–4 seats and one active hold per customer/screening. Expired holds cannot depend on cleanup. FR-05 requires one consistent booking-or-refund outcome; §11 requires durable events to commit with booking changes.

## Decision

Inventory has one `current_hold_id` per seat; `hold_items` retain historical membership. Ownership is live only when its hold is `active` and `expires_at > now()`. A BEFORE INSERT trigger sets both timestamps using the deciding transaction's database clock, with a five-minute window. Updates cannot extend that window or move/change hold identity, quantity or amount. Foreign keys use `ON UPDATE RESTRICT`.

The transaction module calls `claim_seats`, which validates inputs, rejects an existing active customer hold, locks ownership rows, inserts the hold/items, and executes this conditional claim (the complete function and subsequent replacements live in the ordered SQL migrations):

```sql
UPDATE seats s SET current_hold_id = h.id
WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
  AND NOT EXISTS (SELECT 1 FROM booked_seats bs
    WHERE bs.screening_id = s.screening_id AND bs.seat_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM holds old WHERE old.id = s.current_hold_id
    AND old.status = 'active' AND old.expires_at > now())
RETURNING s.id;
```

The locked row count must equal the distinct requested quantity, and the returned update count must equal it too; otherwise the entire transaction raises and rolls back. `claimSeatsInTransaction`, `cleanupExpiredHoldInTransaction` and `releaseHoldInTransaction` permit services to commit outbox/idempotency writes alongside ownership changes. `claimSeats` returns seat IDs/labels, expiry and server-calculated integer-paise amount.

### Lock order

All ownership writers follow **screening → optional idempotency lease → optional customer identity → existing hold rows by ID → seat rows by ID → screening event cursor**. Normal operations take a screening `FOR KEY SHARE`; reset takes it `FOR UPDATE`. Both idempotency acquisition and execution take the screening lock before inserting, taking over or fencing a lease, so reset cannot hold a screening while waiting on an execution that needs it. Release resolves its owned hold's screening before execution. Hold/customer/seat locks use `FOR NO KEY UPDATE`, allowing foreign-key key-share checks, including concurrent conflict-window inserts. Claims lock prior owners before inventory; cleanup, release and confirmation lock their hold before inventory. Conflict-window batches also insert in seat-ID order. Never update several seats in physical/input order. Stale cleanup clears only `WHERE current_hold_id = old_hold_id`. Finalize the already-locked idempotency response before inserting the event as the final statement; acquire no ownership locks after writing an event.

Use short Read Committed transactions. Each statement after a lock wait gets the committed ownership snapshot; `now()` remains the deciding transaction's clock. Callers retry an entire failed transaction only for the classified retryable errors, never individual statements.
Payment initiation follows screening → idempotency lease → customer → hold → attempt, stores the replay response, then inserts `payment.initiated` last. Notifications follow screening → customer → hold → original seats by ID → payment attempt → provider event/refund row → event cursor. The hold lock serializes notifications with release, cleanup and reassignment; confirmation's trigger revalidates the same DB-clock deadline and seat pointers, creates tickets, confirms the hold and inserts `booking.confirmed` last. Late success never updates seat pointers. Refund completion follows screening → hold → refund row → event cursor. No ownership or idempotency writes may follow a domain-event insertion.


Every domain-event insert takes its `screening_event_cursors` row `FOR UPDATE` as the last serialization lock, then allocates the authoritative sequence ID and updates the cursor in the same transaction. The database trigger applies this to HTTP, booking triggers and direct writers alike. The lock is held through commit, so a later event cannot become visible before an earlier ID for that screening. The existing sequence default may consume an unused ID before the trigger; gaps are allowed. A one-statement snapshot reads seats and the committed cursor together. Reset deletes events but preserves the cursor, so resume IDs do not move backwards. An index on `(screening_id, id)` supports ordered replay.

Hold event payloads strictly match the public shared schemas. Customer attribution is a separate `customer_id` UUID column, deliberately not an ownership foreign key: historical attribution survives identity removal and cannot acquire an identity lock after the cursor. The event trigger assigns `at`/`created_at` from `clock_timestamp()` at insertion, truncated to milliseconds, not the transaction-start ownership clock. It is an insertion timestamp just before commit, not a claim that PostgreSQL exposes exact commit time.

### Constraints and durable outcomes

- GiST `holds_one_active_customer` excludes overlapping `(customer_id, screening_id, tstzrange(created_at, expires_at, '[)'))` ranges for active rows. Old expired ranges do not block a new hold, even without cleanup. `btree_gist` is required.
- CHECKs enforce 1–4 seats, valid statuses, five-minute windows and positive paise amounts. Deferred triggers enforce complete hold items, matching totals and exclusive live seat pointers at commit.
- Unique confirmed `(screening_id, seat_id)`, booking-per-hold/payment, ticket codes and booking references prevent duplicate confirmation. Confirmation revalidates live ownership and successful full payment, rejects refund-required attempts, and automatically creates tickets plus a durable `booking.confirmed` event in the same transaction. Confirmed bookings/tickets are immutable outside the explicit reset function.
- Partial unique indexes allow only one initiated and one succeeded payment attempt per hold. New attempts require a live, unpaid hold. Final attempts are absorbing. Refund-required rows must match an unbooked succeeded attempt's amount; booking/refund decisions serialize on the hold. Later payment processing must create the refund-required row for late success, not attempt a reclaim.
- Provider event IDs and refund payment-attempt IDs are unique. Idempotency is unique on `(customer_id, operation, key)` and scoped to a screening for reset. Completed responses can only be 2xx/4xx; records retain at least 24 hours. A 30-second `locked_until` lease allows a crashed in-progress request to be taken over only for the same request hash. Acquisition commits before request work; duplicate live leases return in-progress rather than executing. `takeOverStaleIdempotency` returns a precise lease token; finalization must compare that token so a stale executor cannot finish a replacement's work.
- `reset_demo_screening` locks the screening, refuses pending/running simulations, clears ownership and deletes transient records in FK order. Its transaction-local immutability bypass is restored before returning. Seat IDs, screening and simulation history survive. Database owner credentials are trusted; the reset setting is not a privilege boundary.

### Week 2 execution and conflict channel (FR-03, FR-06, §9)

`POST /screenings/:screeningId/holds` requires `Idempotency-Key` (1–200 non-whitespace printable ASCII characters). Release accepts the same header optionally. Clients generate a key once per user action and reuse it across retries. Keys are scoped by customer and operation (`hold.create` or `hold.release`); canonical JSON of parameters and body is SHA-256 hashed. Payload mismatch returns `409 idempotency_key_reused`; live execution returns `409 idempotency_in_progress`. Completed 2xx/4xx status and full JSON body are replayed, including the original body's request ID. The response header still identifies the current request. Invalid targets may have no screening association. Execution locks and fences the acquired lease, uses a savepoint to recover domain 4xx failures, and commits ownership, ordered event and completed response together. A 5xx rolls back work and removes the owned lease; crashed acquisitions are recoverable after thirty seconds.

Seat IDs are hashed as a sorted set, and object keys use code-unit ordering. In-progress responses carry `Retry-After` with the remaining lease rounded up to seconds (at least one). Retryable SQL failures escape the operation savepoint unchanged so the outer retry reruns the complete transaction once; database outages and interactive-transaction timeouts map to `503 retry_later`. The expiry sweep also purges records past their retention deadline, excluding live execution leases.

Hold creation best-effort enqueues a delayed BullMQ job identified by hold ID. Redis failure is logged, not converted into a failed hold; clients log one connection warning per outage rather than every reconnect attempt. The worker requires `DATABASE_URL` and schedules a repeatable database expiry sweep every 30 seconds; it reinstalls the scheduler after Redis reconnects so queue-data loss does not permanently disable cleanup. Each sweep selects at most 500 expired holds, isolates per-hold errors and retention-purge errors, and uses 30-second transaction wait/execution limits. Cleanup returns only seat IDs/labels actually cleared by `UPDATE … RETURNING`, ordered by row/number, never all historical hold items. A cleanup that clears seats inserts one strict `hold.expired` event through the same ordered database-event trigger as its final transaction statement. Partial reassignment therefore emits only the remaining cleared seats; duplicate or fully superseded jobs emit nothing. If a delayed job arrives before database expiry, it reschedules to the database's `expires_at` plus 250 ms rather than consuming the only wake-up. Invalid hold IDs fail without retry. `hold.created` carries `expiresAt`; `hold.released` and `hold.expired` intentionally omit it from their strict public payloads.

Seat conflicts never enter `domain_events`. The HTTP process counts only the precise conflict IDs reported by the deciding database statement, aggregates each screening/seat over 100 ms windows, and asynchronously persists every pending `conflict_windows` batch before attempting Redis publication. Multiple API instances can produce overlapping windows: consumers sum their counts rather than treating window boundaries as globally aligned. Public `ConflictWindowSchema` timestamps are canonical UTC `…Z`. The configurable pub/sub channel defaults to `seatrush:conflicts`; tests use isolated channels. Notifications are live-only: at most 1,000 are retained per drain, and a Redis failure logs and drops remaining notifications without blocking durable window persistence. Redis commands have a one-second timeout. Shutdown drains pending persistence before disconnecting dependencies. Flushed windows survive process restarts in PostgreSQL; in-memory, not-yet-flushed observations are not crash durable. Pub/sub is not ownership authority or a durable stream.

### Error contract

`classifyDbError` normalizes Prisma statement, deferred-commit and driver-adapter errors:

| SQLSTATE | Classification |
|---|---|
| `SR409` | `seat_conflict` |
| `SR410`, or `23P01` naming `holds_one_active_customer` | `active_hold_exists` |
| `22023` / `22P02` | `invalid_input` (including unknown/foreign seat IDs) |
| `40P01` / `40001` | `retryable` |
| `SR404` / `SR401` | `not_found` / `unauthorized` |
| `08xxx`, `57P01`–`57P03`, connection/pool timeout errors | `unavailable` → HTTP 503 `retry_later` |
| Other errors | `internal` |

## Alternatives rejected

Redis ownership and cleanup-driven availability would make correctness depend on delivery. A partial index using `expires_at > now()` is invalid because index predicates must be immutable; a status-only unique index blocks expired, untidied holds. Independent partial seat acceptance violates FR-02.

## Consequences

The ownership rules deliberately depend on PostgreSQL constraints, raw SQL and triggers, not Prisma query-builder sequencing. Schema changes must preserve these rules and remain migration-diff clean. The invariant checker checks both seat partitioning and confirmed-side ticket, amount, refund and payment consistency. Integration tests use a separate real PostgreSQL database and include concurrent claims, cleanup/reclaim, confirmation/expiry, reset, leases and deliberately injected damage.
