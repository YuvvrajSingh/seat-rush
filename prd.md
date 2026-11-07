# Product Requirements Document: SeatRush

**Version:** 1.1  
**Product:** Cinema booking system with a live concurrency visualization  
**Scope:** Portfolio project demonstrating backend correctness, testing, and reliability

## 1. Product overview

SeatRush simulates **1,000 customers attempting to purchase 100 seats for one three-hour movie screening**.

Users can book tickets through a simple customer interface or launch a controlled simulation. A live dashboard visualizes seat availability, competing requests, temporary holds, payment outcomes, and backend performance.

The system must preserve correct seat ownership during concurrent requests, retries, payment failures, expired holds, and application restarts.

**Core demonstration:** With 1,000 customers each requesting one seat and all payments succeeding, exactly 100 customers receive confirmed tickets, with zero duplicate seat assignments.

## 2. Problem statement

A seat can appear available to several customers simultaneously. Requests may overlap, customers may abandon checkout, and payment notifications may arrive late or more than once.

A successful booking system must:

- Prevent multiple customers from holding or purchasing the same seat.
- Give customers a limited opportunity to complete payment.
- Release abandoned reservations.
- Process retries without duplicating bookings or charges.
- Recover from interruptions without losing ownership information.
- Explain outcomes clearly to customers and observers.

## 3. Goals

| Goal | Success criterion |
|---|---|
| Demonstrate concurrency correctness | No overlapping active ownership of the same seat |
| Demonstrate reliable checkout | Duplicate requests and payment events produce one logical outcome |
| Make backend behaviour visible | Seat changes, conflicts, failures, and recovery appear on the dashboard |
| Demonstrate testing discipline | Critical booking and failure scenarios run automatically |
| Produce reproducible evidence | Each simulation records its configuration, results, and environment |

## 4. Users

**Customer:** Selects seats, temporarily reserves them, completes simulated payment, and receives booking confirmation.

**Demo operator:** Configures and starts simulations, injects failures, and inspects results.

**Technical reviewer:** Explores the application, runs tests, and examines documented engineering decisions.

## 5. Scope

### MVP

- One cinema hall with **10 rows × 10 seats**.
- One screening lasting **three hours**.
- Fixed price of **₹200 per seat**, represented internally in integer paise.
- One to four seats per booking.
- Five-minute seat holds.
- Simulated payments.
- Customer booking interface.
- Live seat map and event dashboard.
- Configurable load generator supporting a 1,000-customer scenario.
- Automated correctness and recovery tests.
- Deployment, API documentation, and reproducible setup.

### Outside the MVP

- Real payments or actual ticket sales.
- Multiple cinemas, dynamic pricing, discounts, and loyalty schemes.
- Kubernetes, multi-region operation, or a microservices architecture.
- AI features.
- Refunds after a valid confirmed purchase.
- Claims of production traffic or real customer adoption.

## 6. Key definitions and rules

| Concept | Definition |
|---|---|
| Screening | A movie showing with a start time and three-hour duration |
| Seat hold | Exclusive temporary ownership of selected seats |
| Hold expiry | Five minutes after the server accepts the hold |
| Confirmed booking | A purchase accepted by the backend after valid payment success |
| Seat conflict | An expected rejection because another customer owns a requested seat |
| Idempotency key | Client-provided identifier used to safely retry a specific operation |

The screening duration and checkout timer are independent. A three-hour screening does **not** create a three-hour seat hold.

All expiry decisions use the database clock (`now()` evaluated inside the deciding transaction). Application-server clocks never decide expiry. Client countdowns are informational.

Seat selection alone does not reserve a seat. Reservation occurs only after the backend successfully creates a hold.

## 7. Customer journey

1. Customer opens the screening and sees the current seat map.
2. Customer selects one to four seats.
3. Customer requests a hold.
4. Backend atomically reserves all requested seats or rejects the entire request.
5. Customer sees the total price and remaining hold time.
6. Customer starts simulated payment.
7. Backend processes the payment result.
8. Customer receives confirmation, a retry option, or an expiry message.

If a hold expires, the customer must obtain a new hold before purchasing.

## 8. Functional requirements

### FR-01: Seat availability

The seat map must distinguish:

- **Available**
- **Held by the current customer**
- **Held by another customer**
- **Confirmed**

Every state must have a text label or symbol in addition to colour.

Displayed availability may briefly lag behind the backend. Every reservation request must revalidate ownership.

### FR-02: Atomic seat holds

The backend must:

- Validate the screening, seat identifiers, quantity, and customer.
- Reserve all requested seats in one transaction.
- Reject the entire request if any requested seat is unavailable.
- Return a hold identifier, expiry timestamp, selected seats, and server-calculated price.
- Prevent overlapping active holds and confirmed ownership for the same screening seat.
- Allow at most **one active hold per customer per screening**. A new hold request while one is active is rejected; the customer must release or complete the existing hold first.

An expired hold must not continue blocking a seat merely because background cleanup is delayed. This is enforced in the data model: any seat-claim query treats a hold with `expires_at <= now()` as non-blocking. Background expiry jobs only tidy up records and emit events; they never decide ownership. A database uniqueness constraint on confirmed (screening, seat) pairs is the final guard against double sale.

### FR-03: Hold expiry and release

- Holds expire after five minutes.
- Customers can explicitly release an unpaid hold.
- Expired or released seats become eligible for another hold.
- Expiry processing must be safe to repeat.
- A delayed expiry task must never release seats belonging to a newer hold.

### FR-04: Simulated payment

The payment simulator must support:

- Success.
- Failure.
- Delayed success.
- Duplicate notifications.
- Notifications delivered out of order.
- Temporary notification delivery failure.

The backend must calculate the amount; the browser cannot choose the payable total.

A failed payment may be retried while the hold remains valid. Only one unresolved payment attempt is permitted per hold at a time.

Each payment attempt follows a state machine: `initiated → succeeded | failed`. Final states are absorbing; a late or conflicting event for a finalized attempt is recorded and ignored. Events are applied in arrival order and validated against the current state, so out-of-order delivery cannot move an attempt backwards.

### FR-05: Payment confirmation and expiry races

Payment success can confirm a booking only if the backend atomically verifies that the hold is still valid and owns the seats.

If expiry and payment confirmation compete, the database must determine one consistent outcome.

For the MVP, a success notification processed after the hold has expired or been released must:

- Leave the booking unconfirmed.
- Never reclaim seats from another customer.
- Create a visible **refund-required** record.
- Trigger an idempotent simulated refund.

Starting payment before expiry does not extend the hold.

### FR-06: Safe retries

Hold creation, payment initiation, and payment-event processing must be idempotent.

- Same key and same payload: return the original logical outcome.
- Same key and different payload: return a conflict.
- Duplicate payment events: do not duplicate confirmation, tickets, or refunds.

Idempotency records must survive application restarts.

Idempotency rules:

- Keys are scoped to (customer, operation); the same key used by different customers is unrelated.
- Records are retained for at least 24 hours.
- A duplicate request that arrives while the original is still executing receives `409 Conflict` (in progress) rather than a second execution.
- Final 2xx and 4xx responses are stored and replayed; 5xx responses are not stored, so the client may retry.

### FR-07: Booking confirmation

A confirmed booking must include:

- Unique booking reference.
- Screening and seat details.
- Total amount.
- Confirmation timestamp.
- A downloadable or printable ticket.

A booking cannot be confirmed twice.

### FR-08: Authorization

Customers can view and operate only their own holds, payments, and bookings.

Simulation controls and reset operations require operator access.

Demo identities are seeded: a pool of customer identities and one operator identity, authenticated with signed bearer tokens. The simulator obtains customer tokens through an operator-only endpoint. Building a complete account-registration system is outside the MVP.

## 9. Visualization requirements

The dashboard must contain four main areas.

| Area | Required content |
|---|---|
| Seat map | All 100 seats with live ownership states |
| Simulation controls | Customer count, arrival pattern, payment behaviour, start and stop |
| Metrics | Available, held, and confirmed seats; request outcomes; latency; errors |
| Event feed | Timestamped holds, conflicts, payments, expirations, and confirmations |

Updates should use server-sent events, with periodic snapshot reconciliation after reconnects.

The frontend must reflect actual backend outcomes. Animations must not invent successful purchases or reservation conflicts.

Under normal demo conditions, state changes should appear within two seconds. This is a target to verify, not a preclaimed result.

## 10. Simulation requirements

The load generator must send requests through the public booking API.

The dashboard simulation is an in-application runner that calls the public API over HTTP. k6 is used only for benchmark reports (§14), not for dashboard-driven runs.

Supported controls:

- Customer count: 100, 500, or 1,000.
- Arrival pattern: burst or spread across a configurable interval.
- Seat selection: random available-looking seat or deliberate competition for selected seats.
- Booking size: one seat for baseline tests; one to four for group scenarios.
- Payment success rate and response delay.
- Customer abandonment rate.
- Bounded retries: after a seat conflict, a simulated customer refreshes the seat map and selects another available seat. It stops when it obtains a hold, when the API reports the screening sold out, or after a configured maximum number of attempts.

A 1,000-customer simulation does not automatically mean 1,000 requests are executing simultaneously. Reports must distinguish configured customers, requests sent, and measured concurrency.

Each run must have a unique identifier and a reproducible random seed.

Stopping a run stops new simulated activity. Existing requests and holds must settle according to normal rules.

## 11. Data and architecture requirements

**Recommended stack:**

| Component | Choice |
|---|---|
| Frontend | Next.js and TypeScript |
| API | Node.js, Express, TypeScript |
| Database | PostgreSQL |
| Database access | Prisma, with SQL migrations where needed |
| Background processing | Redis and BullMQ |
| Tests | Vitest, API integration tests, and k6 |
| Local environment | Docker Compose |
| CI | GitHub Actions |

Start with one API application and one background worker.

**Pinned versions (checked 2026-11-07):** Node.js 24 LTS, TypeScript 6.0, Next.js 16.4, Express 5.3, Prisma 7.10 (not the 8.0 release candidate), BullMQ 6.7, Redis 8, PostgreSQL 18, Vitest 5.1, k6 2.3, pnpm workspaces.

Concurrency-critical statements (conditional seat claims, row locks) use raw SQL inside Prisma-managed SQL migrations and `$transaction`, not the generic query builder.

API documentation is generated as OpenAPI from the same request/response validation schemas the API uses, so documentation cannot drift from behaviour.

The deployment target is decided by the start of Week 5; it must host PostgreSQL and Redis alongside the API and worker.

Core records include screenings, seats, holds, hold items, bookings, payment attempts, payment events, idempotency records, and simulation runs.

**PostgreSQL is the authority for seat ownership.** Redis availability or queue delivery must not determine whether a seat can be sold twice.

Booking changes and their durable event records must be committed consistently. Background delivery must tolerate retries.

## 12. Reliability and security requirements

- Confirmed bookings and active holds survive API restarts.
- Worker restarts cannot duplicate booking side effects.
- Database failures return controlled errors without partial reservations.
- Redis outages cannot corrupt seat ownership.
- Requests use input validation and authorization checks.
- Secrets remain outside source control.
- Logs exclude credentials and sensitive payment information.
- Each request carries a correlation identifier.
- Operator resets cannot run during an active simulation. A reset deletes holds, bookings, payment attempts, payment events, and idempotency records for the demo screening, and retains simulation-run history.
- Rate limits are documented; simulation mode uses explicit configuration rather than silently bypassing protection.

## 13. Acceptance tests

| Test | Expected result |
|---|---|
| 1,000 customers, one seat each, successful timely payments, bounded retries (max attempts sufficient to sell out) | Exactly 100 confirmed seats; no duplicate assignments; remaining customers end with a sold-out or conflict outcome |
| 100 simultaneous hold requests for A7 | Exactly one active hold succeeds |
| Request four seats when one is unavailable | None of the four is newly held |
| Retry a hold request with the same key | Same logical hold; no additional reservation |
| Reuse a key with different seats | Conflict response |
| Customer abandons checkout | Seats become available after expiry |
| Payment success notification arrives twice | One confirmation and one ticket set |
| Payment succeeds after expiry or release and reassignment | New owner remains; original payment enters refund handling |
| Expiry and payment race | One valid outcome; no partial booking |
| API or worker restarts | Durable state remains correct; processing resumes safely |
| Customer accesses another customer’s booking | Access denied |

## 14. Measurement and deliverables

Every benchmark report must state:

- Commit identifier and run configuration.
- Hardware and deployment environment.
- Number of customers and requests.
- Achieved concurrency and request rate.
- p50, p95, and p99 latency.
- Expected conflicts separately from unexpected server errors.
- Final available, held, and confirmed seat counts.
- Results of database invariant checks.

At a settled point, the 100 seats must partition into available, actively held, and confirmed states without overlap.

The final deliverables are a working demo, source repository, API documentation, automated tests, benchmark report, architecture explanation, and a short recorded walkthrough.

## 15. Delivery plan

| Phase | Deliverable |
|---|---|
| Week 1 | Schema, screening, seat map, atomic holds |
| Week 2 | Expiry, ownership checks, idempotency |
| Week 3 | Payment simulation, confirmation, refund handling |
| Week 4 | Dashboard, event stream, load generator |
| Weeks 5–6 | Failure tests, deployment, benchmarks, documentation |

**Release criterion:** All correctness acceptance tests pass. Any unmet performance targets or unsupported recovery scenarios are documented explicitly.
