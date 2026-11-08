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

All ownership writers follow **screening → optional customer identity → existing hold rows by ID → seat rows by ID → screening event cursor**. Normal operations take a screening `FOR KEY SHARE`; reset takes it `FOR UPDATE`. Hold/customer locks use `FOR NO KEY UPDATE`, allowing foreign-key key-share checks. Claims lock prior owners before inventory; cleanup, release and confirmation lock their hold before inventory. Never update several seats in physical/input order. Stale cleanup clears only `WHERE current_hold_id = old_hold_id`. Acquire no ownership locks after writing an event.

Use short Read Committed transactions. Each statement after a lock wait gets the committed ownership snapshot; `now()` remains the deciding transaction's clock. Callers retry an entire failed transaction only for the classified retryable errors, never individual statements.

Every domain-event insert takes its `screening_event_cursors` row `FOR UPDATE` as the last serialization lock, then allocates the authoritative sequence ID and updates the cursor in the same transaction. The database trigger applies this to HTTP, booking triggers and direct writers alike. The lock is held through commit, so a later event cannot become visible before an earlier ID for that screening. The existing sequence default may consume an unused ID before the trigger; gaps are allowed. A one-statement snapshot reads seats and the committed cursor together. Reset deletes events but preserves the cursor, so resume IDs do not move backwards. An index on `(screening_id, id)` supports ordered replay.

Hold event payloads strictly match the public shared schemas. Customer attribution is a separate `customer_id` UUID column, deliberately not an ownership foreign key: historical attribution survives identity removal and cannot acquire an identity lock after the cursor. The event trigger assigns `at`/`created_at` from `clock_timestamp()` at insertion, truncated to milliseconds, not the transaction-start ownership clock. It is an insertion timestamp just before commit, not a claim that PostgreSQL exposes exact commit time.

### Constraints and durable outcomes

- GiST `holds_one_active_customer` excludes overlapping `(customer_id, screening_id, tstzrange(created_at, expires_at, '[)'))` ranges for active rows. Old expired ranges do not block a new hold, even without cleanup. `btree_gist` is required.
- CHECKs enforce 1–4 seats, valid statuses, five-minute windows and positive paise amounts. Deferred triggers enforce complete hold items, matching totals and exclusive live seat pointers at commit.
- Unique confirmed `(screening_id, seat_id)`, booking-per-hold/payment, ticket codes and booking references prevent duplicate confirmation. Confirmation revalidates live ownership and successful full payment, rejects refund-required attempts, and automatically creates tickets plus a durable `booking.confirmed` event in the same transaction. Confirmed bookings/tickets are immutable outside the explicit reset function.
- Partial unique indexes allow only one initiated and one succeeded payment attempt per hold. New attempts require a live, unpaid hold. Final attempts are absorbing. Refund-required rows must match an unbooked succeeded attempt's amount; booking/refund decisions serialize on the hold. Later payment processing must create the refund-required row for late success, not attempt a reclaim.
- Provider event IDs and refund payment-attempt IDs are unique. Idempotency is unique on `(customer_id, operation, key)` and scoped to a screening for reset. Completed responses can only be 2xx/4xx; records retain at least 24 hours. A 30-second `locked_until` lease allows a crashed in-progress request to be taken over only for the same request hash. Acquisition commits before request work; duplicate live leases return in-progress rather than executing. `takeOverStaleIdempotency` returns a precise lease token; finalization must compare that token so a stale executor cannot finish a replacement's work.
- `reset_demo_screening` locks the screening, refuses pending/running simulations, clears ownership and deletes transient records in FK order. Its transaction-local immutability bypass is restored before returning. Seat IDs, screening and simulation history survive. Database owner credentials are trusted; the reset setting is not a privilege boundary.

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
