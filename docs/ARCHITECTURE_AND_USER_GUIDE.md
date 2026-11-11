# SeatRush: Systems Architecture & Visual User Guide

> **Audience:** Engineers, architects, and systems developers learning how to build mission-critical, high-concurrency transactional software.  
> **Core Premise:** 1,000 customers competing simultaneously for 100 cinema seats for a single screening.  
> **The Golden Invariant:** PostgreSQL is the single source of truth for seat ownership. Redis and BullMQ never decide ownership.

---

## 1. System Architecture & Topology

SeatRush is designed around a single immutable engineering rule: **transient queues and caches must never decide state.** Under extreme contention—such as a flash sale or concert drop where 1,000 customers contest 100 seats in the same sub-second window—naive architectures fail because distributed state becomes desynchronized. If Redis holds the hold timers and crashes, inventory is orphaned. If the web UI relies on its local clock to count down expiry, clock skew allows phantom purchases. If database row locks are acquired in arbitrary order, the database engine deadlocks.

SeatRush eliminates these failure modes by treating PostgreSQL 18 as the single authoritative state engine, Express 5 as a transactional API coordinator, BullMQ 6 and Redis 8 as best-effort wake-up messengers, and Next.js 16 as an honest presentation layer.

```
+-------------------------------------------------------------------------------------------------------+
|                                           SEATRUSH TOPOLOGY                                           |
+-------------------------------------------------------------------------------------------------------+

       [ Client Browser ] <=================================> [ Next.js 16 Web UI ]
               ^                                                    (Port 3000)
               |                                                         |
         Direct REST Calls                                               |
         with Bearer Auth                                                |
               |                                                         v
               +--------------------------------------------> [ Express 5 REST API ]
                                                                    (Port 4000)
                                                                    |         |
                                                      Enqueue Jobs  |         | Enforce
                                                      & Wake-ups    |         | Idempotency
                                                                    v         v
[ BullMQ Worker Daemon ] <-------------------------------> [ Redis 8 ]   [ PostgreSQL 18 ]
   * hold-expiry                                            (Port 6379)    (Port 5433)
   * payment-events (simulated webhooks)                    * Job queues   * Single source of truth
   * refunds (2-phase settlement)                           * Pub/Sub      * Row-level locks (FOR NO KEY UPDATE)
   * payment-reconciliation (30s DB sweeps)                 * Ephemeral    * GiST exclusion constraints
                                                                           * Monotonic domain event cursors
```

### 1.1 Infrastructure Topology

| Component | Technology | Default Port | Primary Responsibility |
|---|---|---|---|
| **Web UI** | Next.js 16.4, React 19.3, Tailwind CSS 4 | `3000` | Renders the accessible 10×10 seat grid, calculates client-to-server clock skew, and manages local selection state. |
| **REST API** | Node.js 24 LTS, Express 5.3, TypeScript 6 | `4000` | Enforces authentication, request validation, lease-fenced idempotency, and transactional booking boundaries. |
| **Worker Daemon** | BullMQ 6.7, Node.js 24 | — | Processes delayed hold expiry wake-ups, simulates asynchronous payment gateway webhooks, and runs 30-second reconciliation sweeps. |
| **Database** | PostgreSQL 18 | `5433` (host) | **The single source of truth.** Owns row locking order, atomic conditional updates, strict GiST constraints, and the durable domain event sequence. |
| **Queue / Cache** | Redis 8 (`noeviction`, AOF enabled) | `6379` | Transient queue transport for BullMQ and pub/sub message bus for seat conflict aggregation windows. |

### 1.2 Component & Data Flow Architecture

The following Mermaid diagram illustrates the exact component relationships, protocol boundaries, and storage interactions across SeatRush:

```mermaid
flowchart TB
    classDef client fill:#e0f2fe,stroke:#0284c7,stroke-width:1.5px,color:#0f172a;
    classDef api fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#0f172a;
    classDef queue fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#0f172a;
    classDef worker fill:#d1fae5,stroke:#059669,stroke-width:1.5px,color:#0f172a;
    classDef db fill:#ede9fe,stroke:#7c3aed,stroke-width:1.5px,color:#0f172a;

    subgraph Client["Client Tier"]
        UI["Next.js 16 Web Application<br/>(Port 3000 / React 19)"]:::client
        Store["useBooking Store & Countdown<br/>(Clock Skew Synchronization)"]:::client
    end

    subgraph API["API Gateway & Coordinator"]
        Router["Express 5 HTTP Router<br/>(Port 4000 / CORS & Auth)"]:::api
        Idemp["Idempotency Fencing<br/>(30s Lease & Hash Validation)"]:::api
        BookingSvc["Booking Service<br/>(withDbRetry & SQL Orchestration)"]:::api
        PaymentSvc["Payment Service<br/>(HMAC Signature & State Guard)"]:::api
    end

    subgraph Queues["Distributed Queues & PubSub"]
        QExpiry[("BullMQ: hold-expiry<br/>(Concurrency: 1 / 5m Delayed)")]:::queue
        QPayment[("BullMQ: payment-events<br/>(Concurrency: 32 / Async Sim)")]:::queue
        QRefund[("BullMQ: refunds<br/>(Concurrency: 8 / Compensating)")]:::queue
        QRecon[("BullMQ: payment-reconciliation<br/>(Repeat Every 30s)")]:::queue
        PubSub[("Redis 8 Pub/Sub Stream<br/>(seatrush:conflicts Windows)")]:::queue
    end

    subgraph Workers["Worker Daemons"]
        BullWorker["BullMQ Worker Daemon<br/>(Queue Dispatcher)"]:::worker
        SimEngine["Payment Simulator Engine<br/>(6 Realistic Chaos Scenarios)"]:::worker
        Sweeper["Reconciliation Sweeper<br/>(30s Periodic Safety Net)"]:::worker
    end

    subgraph Database["Authoritative PostgreSQL"]
        SeatsTable[("seats & hold_items<br/>(Row Locks: FOR NO KEY UPDATE)")]:::db
        HoldsTable[("holds Table<br/>(GiST Exclusion / 5-min Window)")]:::db
        BookingsTable[("bookings & booked_seats<br/>(Unique Ticket Constraints)")]:::db
        PaymentsTable[("payment_attempts & events<br/>(Absorbing State Machine Triggers)")]:::db
        EventCursor[("screening_event_cursors<br/>(Monotonic Sequence Counter)")]:::db
        IdempTable[("idempotency_records<br/>(Scoped Fencing & Lease Tokens)")]:::db
    end

    UI -->|"1. POST /auth/demo-session<br/>(Signed HMAC Token)"| Router
    UI -->|"2. GET /screenings/:id/snapshot<br/>(10x10 Seat Matrix)"| Router
    UI -->|"3. POST /screenings/:id/holds<br/>(Idempotency-Key Header)"| Router
    UI -->|"4. POST /holds/:id/payments<br/>(Chaos Scenario Payload)"| Router
    Store -.->|"Manages selection &<br/>clock skew offset"| UI

    Router -->|"Acquire 30s lease"| Idemp
    Idemp -->|"Check hash & write lease"| IdempTable
    Router -->|"Orchestrate hold & release"| BookingSvc
    Router -->|"Orchestrate payment lifecycle"| PaymentSvc

    BookingSvc -->|"SELECT claim_seats()<br/>(Ordered row-level locks)"| SeatsTable
    BookingSvc -->|"INSERT active hold<br/>(GiST exclusion constraint)"| HoldsTable
    BookingSvc -.->|"Best-effort enqueue<br/>(delay: 5m)"| QExpiry
    BookingSvc -.->|"Broadcast conflict count<br/>(100ms aggregation)"| PubSub

    PaymentSvc -->|"INSERT payment_attempts<br/>(status: 'initiated')"| PaymentsTable
    PaymentSvc -.->|"Enqueue simulation job"| QPayment

    QExpiry --> BullWorker
    QPayment --> BullWorker
    QRefund --> BullWorker
    QRecon --> BullWorker

    BullWorker --> SimEngine
    BullWorker --> Sweeper

    SimEngine -->|"POST /payments/notifications<br/>(HMAC-SHA256 Signed Webhook)"| PaymentSvc
    PaymentSvc -->|"applyNotification()<br/>(Absorbing state trigger)"| PaymentsTable
    PaymentSvc -->|"INSERT booking & booked_seats<br/>(Generate ticket codes)"| BookingsTable
    PaymentSvc -->|"Lock cursor FOR UPDATE<br/>& emit domain event"| EventCursor
    PaymentSvc -.->|"Late success -> enqueue refund"| QRefund

    Sweeper -->|"findStalledPaymentAttempts()<br/>(Resume unapplied >30s attempts)"| PaymentsTable
    Sweeper -->|"cleanup_expired_hold()<br/>(Reclaim inventory from dead locks)"| SeatsTable
    Sweeper -->|"Check expired active holds"| HoldsTable
```

### 1.3 Package Structure & Monorepo Boundaries

SeatRush is organized as a pnpm workspace with strict physical boundaries to prevent architectural leakage:

```
seat-rush/
├── packages/
│   ├── shared/          # Universal schemas, invariants, and serialization contracts
│   └── db/              # Prisma schema, SQL migrations, stored procedures, client pool
└── apps/
    ├── api/             # Express 5 REST API, routes, middleware, and OpenAPI generator
    ├── worker/          # BullMQ background workers, payment simulator, and sweeper
    └── web/             # Next.js 16 Web UI, seat map, clock sync, and ticket views
```

- **`packages/shared`:** Contains zero database or framework dependencies. It houses Zod contracts (`CreateHoldRequestSchema`, `PaymentAttemptSchema`, `ScreeningSnapshotSchema`), timing constants (`HOLD_TTL_SECONDS = 300`, `MAX_SEATS_PER_HOLD = 4`), queue names (`QUEUE_NAMES`), and cryptography utilities (`signPaymentNotification`, `verifyPaymentNotification`).
- **`packages/db`:** Completely encapsulates PostgreSQL access. Prisma handles migrations and object mapping, but **all transactional concurrency logic lives in raw SQL functions** (`claim_seats`, `cleanup_expired_hold`, `release_hold`, `reset_demo_screening`). No API route or worker ever writes raw SQL queries to lock seats directly; they invoke strictly typed TypeScript wrappers (`claimSeatsInTransaction`, `cleanupExpiredHoldInTransaction`). It also contains `checkSeatInvariants`, the single-query invariant verification engine.
- **`apps/api`:** Consumes `@seatrush/db` and `@seatrush/shared`. Responsible for HTTP lifecycle: parameter parsing, signed demo session authentication, lease-based idempotency handling (`idempotent`), error normalization (`classifyDbError`), and CORS/security headers.
- **`apps/worker`:** The async processing engine. It runs the BullMQ processors for hold expiries, payment simulations, and refunds. Crucially, it hosts the periodic database recovery sweeps (`startExpirySweep`, `startPaymentSweeps`) that rescue orphaned jobs if Redis restarts.
- **`apps/web`:** Pure client and server components. It communicates with `apps/api` strictly over HTTP using standard fetch APIs. It never talks directly to PostgreSQL or Redis.

---

## 2. Visual User Guide & Step-by-Step Systems Walkthrough

Every visual interaction in SeatRush maps to a concrete systems programming pattern. The following walkthrough explains what is happening under the hood across all eight screens.

### 2.0 Complete End-to-End User Transaction Journey

The sequence diagram below provides a panoramic view of the entire eight-stage transaction lifecycle—from initial anonymous session provisioning and seat map caching to atomic conditional holding, asynchronous payment simulation, absorbing state machine verification, and printable ticket rendering:

```mermaid
sequenceDiagram
    autonumber

    box rgba(224, 242, 254, 0.7) "Client Browser Tier"
        actor User as Customer Browser
        participant Web as Next.js 16 Web UI
    end

    box rgba(254, 243, 199, 0.7) "API Gateway & Coordinator"
        participant API as Express 5 API
    end

    box rgba(243, 232, 255, 0.7) "Authoritative PostgreSQL 18"
        participant DB as PostgreSQL 18 Engine
    end

    box rgba(209, 250, 229, 0.7) "Worker & Simulation Tier"
        participant Queue as BullMQ / Redis 8
        participant Worker as Worker & Payment Simulator
    end

    %% Phase 1: Session Minting
    Note over User,Worker: Phase 1: Session Minting (Screen 1 & 2)
    User->>Web: Navigate to /book (No demo token present)
    activate Web
    Web->>API: POST /auth/demo-session
    activate API
    API->>DB: INSERT INTO identities (demo_key, role, display_name)
    activate DB
    DB-->>API: Row created (customer_id: UUID)
    deactivate DB
    API-->>Web: 200 OK (HMAC-SHA256 Signed Bearer Token)
    deactivate API
    Web->>Web: Persist token to sessionStorage
    deactivate Web

    %% Phase 2: Seat Map Fetch
    Note over User,Worker: Phase 2: Seat Map Snapshot (Screen 2)
    Web->>API: GET /screenings/:id/snapshot
    activate Web
    activate API
    API->>DB: SELECT seats, active holds, booked_seats
    activate DB
    DB-->>API: 100-Seat Matrix + serverTime timestamp
    deactivate DB
    API-->>Web: 200 OK { screening, seats, serverTime }
    deactivate API
    Web->>Web: Compute clockOffsetMs = (sent + received)/2 - serverTime
    Web-->>User: Render accessible 10x10 DOM seat grid
    deactivate Web

    %% Phase 3: Local Selection
    Note over User,Worker: Phase 3: Local Seat Selection (Screen 3 - Zero Server Load)
    User->>Web: Click seats D4, D5, D6
    activate Web
    Note over Web: Local React State Update (anti-hoarding)<br/>Zero DB locks, zero network requests
    Web-->>User: Highlight yellow ("Selected"), show subtotal ₹1,050.00
    deactivate Web

    %% Phase 4: Atomic Hold
    Note over User,Worker: Phase 4: Atomic Hold & Countdown (Screen 4)
    User->>Web: Click "Hold seats (5:00)"
    activate Web
    Web->>API: POST /screenings/:id/holds<br/>Headers: Idempotency-Key, Bearer Token<br/>Body: { seatIds: [D4, D5, D6] }
    activate API
    API->>DB: BEGIN TRANSACTION (Read Committed)
    activate DB
    API->>DB: Reserve 30s Idempotency Lease (idempotency_records)
    API->>DB: SELECT claim_seats(screening_id, customer_id, seat_ids)
    Note over DB: 1. SELECT seats ORDER BY id FOR NO KEY UPDATE<br/>2. GiST constraint: No active hold for customer<br/>3. UPDATE seats SET current_hold_id = h.id
    DB-->>API: Hold row created (hold_id, expires_at: T+5m)
    API->>DB: Record completed response in idempotency_records
    API->>DB: COMMIT TRANSACTION
    deactivate DB
    API-)Queue: Best-effort enqueue hold-expiry (delay: 5m)
    API-->>Web: 201 Created { holdId, expiresAt, serverTime, seats }
    deactivate API
    Web->>Web: Start synchronized countdown timer (5:00) with clockOffsetMs
    Web-->>User: Display "Held for you" countdown panel
    deactivate Web

    %% Phase 5: Payment Initiation
    Note over User,Worker: Phase 5: Payment Initiation (Screen 5)
    User->>Web: Select "delayed_success" & click "Pay ₹1,050.00"
    activate Web
    Web->>API: POST /holds/:id/payments<br/>Body: { scenario: "delayed_success" }
    activate API
    API->>DB: INSERT INTO payment_attempts (status: 'initiated')
    activate DB
    DB-->>API: Attempt created (attempt_id: UUID)
    deactivate DB
    API-)Queue: Enqueue simulation job in payment-events queue
    API-->>Web: 202 Accepted { attemptId, status: "initiated" }
    deactivate API
    Web-->>User: Display animated processing spinner
    deactivate Web

    %% Phase 6: Simulator Delivery
    Note over User,Worker: Phase 6: Async Webhook Simulation Delivery
    Queue-)Worker: Pull delayed simulation job (T+10s)
    activate Worker
    Note over Worker: Compute webhook payload<br/>Generate HMAC-SHA256 signature
    Worker->>API: POST /payments/notifications<br/>Header: x-seatrush-signature<br/>Body: { attemptId, outcome: "succeeded" }
    activate API
    API->>API: verifyPaymentNotification() via crypto.timingSafeEqual

    %% Phase 7: Booking Confirmation
    Note over User,Worker: Phase 7: Booking Confirmation & Absorbing State Commit
    API->>DB: BEGIN TRANSACTION
    activate DB
    API->>DB: applyNotification() / guard_payment_transition()
    Note over DB: 1. SELECT holds FOR UPDATE (assert expires_at > now())<br/>2. INSERT INTO bookings & booked_seats<br/>3. Lock screening_event_cursors FOR UPDATE<br/>4. INSERT INTO domain_events ('booking.confirmed')<br/>5. UPDATE payment_attempts SET status = 'succeeded'
    DB-->>API: Confirmation successful (booking_id: UUID)
    API->>DB: COMMIT TRANSACTION
    deactivate DB
    API-->>Worker: 200 OK { disposition: "applied", bookingId }
    deactivate API
    deactivate Worker

    %% Phase 8: Ticket Rendering
    Note over User,Worker: Phase 8: Ticket Rendering & Admission Pass (Screen 7 & 8)
    Web->>API: GET /screenings/:id/snapshot
    activate Web
    activate API
    API-->>Web: 200 OK (Seats transition from "held" to "booked")
    deactivate API
    Web->>API: GET /bookings/:bookingId
    activate API
    API->>DB: SELECT * FROM bookings WHERE id = $1 AND customer_id = $2
    activate DB
    DB-->>API: Booking record with ticket codes and amount
    deactivate DB
    API-->>Web: 200 OK { bookingId, reference, seats, amountPaise }
    deactivate API
    Web-->>User: Render Photorealistic Cinema Ticket Stub (Screen 7)
    User->>Web: Click "View printable ticket" (/bookings/:id)
    Web-->>User: Render High-Contrast Black & White Admission Pass (Screen 8)
    deactivate Web
```

---

### Screen 1: Landing Page (`screenshots/01-landing-page.png`)

![Landing Page](screenshots/01-landing-page.png)

#### User Experience
The user arrives at `http://localhost:3000`. The landing page displays:
1. The **1,000 customers / 100 seats** challenge overview.
2. An interactive 10×10 auditorium layout preview.
3. The cinema's **House rules**: 1–4 seats per booking, 5-minute database-enforced hold window, integer-paise pricing (₹350.00 / 35,000 paise), and screening duration.
4. A live **API Health Probe** status indicator.

#### Systems Engineering Deep-Dive
- **Dynamic Server Health Check:** The Next.js page uses React Server Components (`app/page.tsx`) with a streaming `<Suspense>` boundary around `<ApiStatus />` (`components/api-status.tsx`). Every page render dynamically pings `GET /healthz` on the Express API. The probe executes a single lightweight database ping (`SELECT 1`) on an isolated single-connection pool and a Redis `PING`. If either fails, the badge transitions to warning/error without taking down the static shell.
- **Paise Representation (No Floating Point):** The house rules display `₹350.00`. In the database and shared schemas, this is stored strictly as `seatPricePaise: 35000` (`packages/shared/src/booking.ts`). Systems handling financial transactions must never use IEEE 754 floating-point numbers due to precision loss (e.g. `0.1 + 0.2 = 0.30000000000000004`). All calculations across SeatRush use integer arithmetic.

---

### Screen 2: Interactive Seat Map (`screenshots/02-booking-seatmap.png`)

![Interactive Seat Map](screenshots/02-booking-seatmap.png)

#### User Experience
Clicking **"Book seats"** navigates to `/book`. The client loads the full 10×10 seat grid (rows A through J, columns 1 through 10). The top bar displays the movie title (*SeatRush: Opening Night*), the screening time, and an anonymous session badge (*Demo Customer*).

#### Systems Engineering Deep-Dive
- **Anonymous Session Auto-Provisioning (ADR 0002):**
  When `/book` loads, `useBooking` checks `sessionStorage` for a demo token. If absent, it invokes:
  ```http
  POST /auth/demo-session HTTP/1.1
  Host: localhost:4000
  Content-Type: application/json
  ```
  The API (`apps/api/src/routes/booking.ts`) creates a new row in `identities`:
  ```sql
  INSERT INTO identities (demo_key, display_name, role)
  VALUES ('web-' || gen_random_uuid(), 'Demo Customer', 'customer');
  ```
  The server signs a lightweight bearer token:
  $$\text{Token} = \text{base64url}(\text{claims}) \mathbin{\Vert} \text{'.'}\mathbin{\Vert} \text{base64url}(\text{HMAC-SHA256}(\text{encoded\_claims}, \text{AUTH\_TOKEN\_SECRET}))$$
  There is no third-party JWT library and no external identity provider. The token is validated in constant time (`crypto.timingSafeEqual`) on subsequent calls. A per-IP rate limiter allows a maximum of 10 session creations per 60 seconds to prevent identity table exhaustion.
- **DOM Accessibility vs Canvas:** Rather than drawing an unstyled WebGL or HTML5 canvas, the seat grid is rendered as a standards-compliant accessible DOM table (`role="grid"`). Each seat is an interactive button with `role="gridcell"`, `aria-label="Seat D5, ₹350.00, available"`, and arrow-key navigation (`grid-navigation.ts`). Screen readers announce state updates via `aria-live="polite"` regions.

---

### Screen 3: Local Seat Selection (`screenshots/03-seat-selection.png`)

![Seat Selection](screenshots/03-seat-selection.png)

#### User Experience
The user clicks on seats **D4, D5, and D6**. The seats highlight in yellow (`Selected`), and the side panel updates to show **"Your seats: D4, D5, D6"**, the subtotal **"₹1,050.00"**, and the primary action button **"Hold seats (5:00)"**.

#### Systems Engineering Deep-Dive
- **The Anti-Hoarding Pattern: Client-Side Selection vs Server Reservation:**
  Why does clicking a seat **not** send a reservation request to the backend?
  > **Common Naive Flaw:** Many amateur booking systems send an HTTP `POST /reserve` the moment a user clicks a seat on the map. In a 1,000-user rush, this causes instantaneous Denial-of-Service (DoS) and complete inventory hoarding: malicious or indecisive users click 4 seats, hold them for minutes without paying, abandon the tab, and lock out legitimate buyers.
  
  In SeatRush, clicking a seat is **100% local React state** (`state.selection: string[]` in `useBooking`). The server has no knowledge of local selections. No database locks are acquired, no Redis keys are set, and no seats are blocked for other customers until the user explicitly commits to the selection by clicking **"Hold seats"**.

---

### Screen 4: Atomic Hold & Countdown (`screenshots/04-hold-countdown.png`)

![Hold Countdown](screenshots/04-hold-countdown.png)

#### User Experience
The user clicks **"Hold seats"**. In milliseconds, the side panel updates to **"Held for you"**, displaying a 5-minute countdown clock (`5:00`), a breakdown of the held seats, and a **"Release seats"** button alongside the payment scenario options.

#### Systems Engineering Deep-Dive
This single user action triggers one of the most sophisticated transactional workflows in SeatRush.

```mermaid
sequenceDiagram
    autonumber
    box rgba(224, 242, 254, 0.7) "Client Browser"
        actor User as Client Browser
    end
    box rgba(254, 243, 199, 0.7) "API Gateway & Coordinator"
        participant API as Express API
    end
    box rgba(243, 232, 255, 0.7) "Authoritative PostgreSQL 18"
        participant DB as PostgreSQL 18
    end
    box rgba(209, 250, 229, 0.7) "Distributed Messaging"
        participant Redis as Redis / BullMQ
    end

    User->>API: POST /screenings/:id/holds<br/>Headers: Idempotency-Key, Bearer Token<br/>Body: { seatIds: [D4, D5, D6] }
    activate API
    Note over API,DB: Start Read Committed Transaction
    API->>DB: Acquire 30s Idempotency Lease (idempotency_records)
    activate DB
    DB-->>API: Lease granted (status: in_progress)
    API->>DB: SELECT claim_seats(screening_id, customer_id, seat_ids)
    
    rect rgba(243, 232, 255, 0.5)
        Note over DB: Atomic claim_seats() Execution<br/>1. SELECT screenings FOR KEY SHARE<br/>2. SELECT identities FOR NO KEY UPDATE<br/>3. SELECT holds (prior owners) ORDER BY id FOR NO KEY UPDATE<br/>4. SELECT seats ORDER BY id FOR NO KEY UPDATE (deadlock prevention)<br/>5. Verify no active hold exists for customer (GiST exclusion)<br/>6. INSERT INTO holds & hold_items (5-minute TTL)<br/>7. UPDATE seats SET current_hold_id = h.id RETURNING s.id
    end

    DB-->>API: Returns claimed seat IDs (D4, D5, D6)
    API->>DB: Store completed 201 response in idempotency_records
    API->>DB: COMMIT Transaction
    deactivate DB
    Note over API,DB: Transaction Committed Durably
    API-)Redis: Best-effort enqueue delayed job (hold-expiry, delay: 5m)
    API-->>User: 201 Created { holdId, expiresAt, serverTime, seats }
    deactivate API
    Note over User: Calculate clockOffsetMs<br/>Start synchronized countdown timer
```

1. **Idempotency Lease Fencing (`apps/api/src/idempotency.ts`):**
   The browser sends an `Idempotency-Key` header (UUID). The API executes an atomic lease reservation:
   ```sql
   INSERT INTO idempotency_records (customer_id, screening_id, operation, key, request_hash, status, locked_until)
   VALUES ($1, $2, 'hold.create', $3, $4, 'in_progress', now() + interval '30 seconds')
   ON CONFLICT (customer_id, operation, key) DO UPDATE ...
   ```
   If a network glitch causes the browser to retry while the first call is still executing, the second request sees `status = 'in_progress'` and is safely rejected with HTTP 409 `idempotency_in_progress` and a `Retry-After` header.

2. **The `claim_seats` Stored Procedure (`packages/db/prisma/migrations/.../migration.sql`):**
   To prevent race conditions and deadlocks, PostgreSQL executes `claim_seats`:
   - **Deadlock Prevention via Strict Lock Ordering:**
     If User 1 requests seats `[D4, D5]` and User 2 requests seats `[D5, D4]`, a naive database will lock D4 for User 1 and D5 for User 2, resulting in an immediate deadlock exception (`40P01`). SeatRush enforces that **all seats are locked in ascending UUID order**:
     ```sql
     PERFORM id FROM seats
     WHERE screening_id = p_screening_id AND id = ANY(p_seat_ids)
     ORDER BY id FOR NO KEY UPDATE;
     ```
   - **All-or-Nothing Atomic Conditional Update:**
     The hold is claimed only if every single requested seat is completely free:
     ```sql
     WITH claimed_seats AS (
       UPDATE seats s SET current_hold_id = h.id
       WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
         AND NOT EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id)
         AND NOT EXISTS (SELECT 1 FROM holds old WHERE old.id = s.current_hold_id
                         AND old.status = 'active' AND old.expires_at > now())
       RETURNING s.id
     ) SELECT count(*) INTO claimed FROM claimed_seats;
     
     IF claimed <> n THEN
       RAISE EXCEPTION 'seat conflict' USING ERRCODE = 'SR409';
     END IF;
     ```
   - **GiST Single Active Hold Exclusion:**
     PostgreSQL's `btree_gist` index enforces that a single customer identity can hold at most one active hold range across the screening:
     ```sql
     EXCLUDE USING gist (customer_id WITH =, screening_id WITH =, tstzrange(created_at, expires_at, '[)') WITH &&)
     WHERE (status = 'active');
     ```

3. **Client Clock Skew Compensation (`apps/web/src/lib/countdown.ts`):**
   The client computer's local clock could be skewed by seconds or hours. If the client simply calculated `expiresAt - Date.now()`, the countdown would be wrong. SeatRush eliminates clock skew by calculating a midpoint offset:
   ```typescript
   export function clockOffsetMs(serverTimeIso: string, sentAtMs: number, receivedAtMs: number): number {
     const roundTripLatencyMidpoint = (sentAtMs + receivedAtMs) / 2;
     return Date.parse(serverTimeIso) - roundTripLatencyMidpoint;
   }
   ```
   When the countdown reaches `0:00`, the UI displays **"Checking with box office…"** (`phase: "checking"`). It **never** unilaterally marks seats as released on the client.

---

### Screen 5: The 6 Payment Simulation Scenarios (`screenshots/05-payment-scenarios.png`)

![Payment Scenarios](screenshots/05-payment-scenarios.png)

#### User Experience
In the side panel under **"Payment provider (demo)"**, the user is presented with six radio button scenarios representing real-world payment gateway behaviors:
1. **Approve (`success`):** Approves immediately.
2. **Decline (`failure`):** Fails payment; allows retry while hold remains active.
3. **Approve after 10 seconds (`delayed_success`):** Tests payment settling while hold countdown continues.
4. **Approve twice (`duplicate_success`):** Simulates at-least-once webhook delivery.
5. **Approve out of order (`out_of_order`):** Delivers terminal approval *before* a delayed `processing` notification.
6. **Approve after lost deliveries (`delivery_failure`):** Simulates network transit loss (worker fails twice, BullMQ retries).

#### Systems Engineering Deep-Dive
Payment gateways do not confirm transactions synchronously over the user's HTTP request. Instead, they accept payment details and asynchronously notify the merchant server via webhook. This architecture is prone to network partitions, duplicate deliveries, out-of-order execution, and race conditions with inventory hold timers.

SeatRush models this faithfully by running the payment simulator in the worker daemon (`apps/worker/src/payments.ts`) and posting signed webhook payloads to `POST /payments/notifications` on the API.

| Scenario | Worker Delivery Pattern | API State Machine Reaction | PostgreSQL Concurrency Defense |
|---|---|---|---|
| **`success`** | Delivers 1 webhook with `outcome: "succeeded"` | Transitions `payment_attempts.status` to `succeeded`. Creates `bookings` and `booked_seats`. | Hold lock serializes with expiry. Confirms booking atomically. |
| **`failure`** | Delivers 1 webhook with `outcome: "failed"` | Marks attempt `failed`. Hold remains `active`. | Customer can retry payment with a fresh attempt. |
| **`delayed_success`** | BullMQ delays job for 10,000 ms before delivering approval. | If hold is still `active`: confirms booking.<br>If hold expired during delay: **creates `refund_required`**. | **The Golden Rule:** Late success **never** re-claims inventory. It issues an automatic refund. |
| **`duplicate_success`** | Worker fires two consecutive webhooks with identical `providerEventId`. | First webhook confirms booking. Second webhook returns `{ disposition: "duplicate" }`. | `payment_events.provider_event_id` unique constraint. Trigger emits `payment.notification_ignored`. |
| **`out_of_order`** | Delivers `outcome: "succeeded"` first, followed by `outcome: "processing"`. | Approval confirms booking and sets attempt to `succeeded` (absorbing). Later `processing` webhook is ignored. | Absorbing state trigger `guard_payment_transition()` rejects any mutation to finalized attempts. |
| **`delivery_failure`** | Worker deliberately throws errors on the first 2 attempts, then succeeds on retry 3. | BullMQ catches the failure and backs off exponentially (`1s * 2^(attempt-1)`). Webhook delivers on attempt 3. | Durable attempt progress saved in BullMQ `job.progress`. Survives worker crashes. |

- **Webhook Cryptographic Signature:**
  All notifications require an HMAC-SHA256 signature in the `x-seatrush-signature` header:
  ```typescript
  const signature = crypto.createHmac("sha256", secret).update(rawJsonBuffer).digest("hex");
  ```
  The API validates this in constant time using `verifyPaymentNotification` before parsing JSON.

---

### Screen 6: Concurrency Conflict (409) (`screenshots/06-seat-conflict-409.png`)

![Seat Conflict 409](screenshots/06-seat-conflict-409.png)

#### User Experience
Two users in separate browser tabs attempt to hold seat **D5** at the same second. User 1's request commits first. User 2's screen immediately reacts:
1. A warning banner appears: **"Seat D5 was just taken by another customer. Your other seats remain selected."**
2. Seat D5 turns red on the interactive grid (`data-status="taken"`).
3. The remaining unconflicted seats (D4 and D6) remain selected, allowing User 2 to immediately pick another replacement seat without starting over.

#### Systems Engineering Deep-Dive
- **Structured Error Propagation:**
  When `claim_seats` detects that seat D5 already has an active hold or booking, it gathers all conflicting seat UUIDs into a JSONB array and raises custom SQLSTATE `SR409`:
  ```sql
  SELECT jsonb_agg(s.id ORDER BY s.id) INTO conflicts
  FROM seats s LEFT JOIN holds old ON old.id = s.current_hold_id
  WHERE s.screening_id = p_screening_id AND s.id = ANY(p_seat_ids)
    AND (EXISTS (SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id)
      OR (old.status = 'active' AND old.expires_at > now()));

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'seat conflict: %', conflicts USING ERRCODE = 'SR409', DETAIL = conflicts::text;
  END IF;
  ```
- **Error Normalization (`packages/db/src/errors.ts`):**
  Prisma's pg driver adapter may discard PostgreSQL `DETAIL` strings under certain pool configurations. SeatRush embeds the conflicting UUIDs directly into the exception message. `classifyDbError` parses the message, maps `SR409` to HTTP 409 `seat_conflict`, and returns:
  ```json
  {
    "error": {
      "code": "seat_unavailable",
      "message": "Seat conflict",
      "seatIds": ["f3a1...d5"]
    }
  }
  ```
- **Reducer Surgical Pruning (`apps/web/src/lib/booking-state.ts`):**
  The client reducer handles `hold-failed` by filtering *only* the conflicting seat ID out of `state.selection`:
  ```typescript
  case "hold-failed": {
    const { code, seatIds = [] } = action.failure;
    if (code === "seat_unavailable") {
      const taken = seatIds.filter((id) => state.selection.includes(id));
      return {
        ...state,
        selection: state.selection.filter((id) => !taken.includes(id)),
        taken,
        notice: notify(state, "problem", holdFailureMessage({ code, takenLabels }))
      };
    }
  }
  ```
- **Sub-Second Conflict Pub/Sub Aggregation:**
  Conflicts never pollute the durable `domain_events` table (which is reserved for committed state changes). Instead, the API aggregates conflict counts over 100ms buckets in `conflict_windows` and broadcasts them via Redis pub/sub (`seatrush:conflicts`) so live dashboards see heatmaps of contention in real time.

---

### Screen 7: Booking Confirmed & Ticket Stub (`screenshots/07-booking-confirmed.png`)

![Booking Confirmed](screenshots/07-booking-confirmed.png)

#### User Experience
Upon payment approval, the side panel unmounts the hold timer and presents the **Booking Confirmed** view. It renders a photorealistic cinema ticket stub with:
- Movie title: *SeatRush: Opening Night*
- Show date and confirmation timestamp
- Booking reference: `SR-87B2E79F0BBF436BA70390FE...`
- Seats: **D4, D5, D6**
- Total amount paid: **₹1,050.00**
- A prominent button: **"View printable ticket"**

#### Systems Engineering Deep-Dive
- **Atomic Confirmation & Unique Constraints:**
  When the payment notification arrives, `applyNotification()` executes within a strict transaction:
  ```sql
  INSERT INTO bookings (hold_id, screening_id, customer_id, payment_attempt_id, amount_paise)
  VALUES ($1, $2, $3, $4, $5) RETURNING id;
  ```
  PostgreSQL triggers automatically create tickets in `booked_seats` for each seat in the hold. Multiple partial unique indexes protect against corruption:
  - `booked_seats(screening_id, seat_id) UNIQUE`: Physically impossible for two bookings to claim the same seat.
  - `bookings(hold_id) UNIQUE` and `bookings(payment_attempt_id) UNIQUE`: Prevents double-booking a single payment or hold.
- **Monotonic Domain Event Cursor (`screening_event_cursors`):**
  A durable domain event `booking.confirmed` is emitted in the exact same transaction:
  ```sql
  SELECT last_event_id FROM screening_event_cursors
  WHERE screening_id = p_screening_id FOR UPDATE;
  
  INSERT INTO domain_events (id, screening_id, booking_id, kind, payload)
  VALUES (nextval('domain_events_id_seq'), p_screening_id, p_booking_id, 'booking.confirmed', ...);
  
  UPDATE screening_event_cursors SET last_event_id = ...;
  ```
  Because the event cursor is locked `FOR UPDATE` until transaction commit, events are guaranteed to become visible in strictly increasing sequential order without gaps or out-of-order timestamps.
- **Hybrid Graphic Compositing (`apps/web/src/components/ticket-stub.tsx`):**
  Per project design guidelines, no AI-generated fake text or canvas hacks are used. The ticket uses a clean, high-resolution photography asset (`ticket-stub.webp`) as an ambient backdrop, and overlays real semantic HTML text using CSS container queries (`@container`, `cqi` units). The ticket scales flawlessly from mobile screens to 4K displays while remaining accessible to screen readers and DOM inspectors.

---

### Screen 8: Dedicated Printable Ticket View (`screenshots/08-printable-ticket.png`)

![Printable Ticket](screenshots/08-printable-ticket.png)

#### User Experience
Clicking **"View printable ticket"** navigates to `/bookings/[bookingId]`. The page displays a dedicated, high-contrast, distraction-free cinema admission pass with individual ticket codes for each seat and a **"Print ticket"** action.

#### Systems Engineering Deep-Dive
- **Owner-Scoped Authorization (FR-08 / ADR 0002):**
  The route `GET /bookings/:bookingId` is protected by customer authentication:
  ```sql
  SELECT b.* FROM bookings b
  WHERE b.id = $1 AND b.customer_id = $2;
  ```
  If a customer attempts to view another user's booking ID, the API returns HTTP 404 `not_found` rather than HTTP 403 `forbidden`. This timing-safe pattern prevents unauthorized attackers from probing or enumerating valid booking IDs.
- **Print Media Query Styles (`@media print`):**
  When the user presses Ctrl+P or clicks "Print ticket", CSS `@media print` rules take effect:
  ```css
  @media print {
    body { background: white; color: black; }
    header, footer, button, .no-print { display: none !important; }
    .ticket-card { border: 2px solid black; box-shadow: none; }
  }
  ```
  The photorealistic background image and dark theme colors are stripped completely, producing an ink-efficient, crisp black-and-white printout suitable for theater turnstiles.

---

## 3. Background Processing & Distributed Resilience Patterns

In distributed systems, background workers and queues are failure-prone: worker instances can be killed by the OS (OOM), networks can drop packets, and Redis instances can restart. SeatRush is built to withstand all three without manual intervention.

### 3.1 BullMQ Worker Queues & Job Roles

SeatRush uses four dedicated BullMQ queues, each isolated by responsibility and concurrency:

```
+-------------------------------------------------------------------------------------------------+
|                                     BULLMQ QUEUE TOPOLOGY                                       |
+-------------------------------------------------------------------------------------------------+

  1. hold-expiry                  2. payment-events              3. refunds
  [ Concurrency: 1 ]              [ Concurrency: 32 ]            [ Concurrency: 8 ]
  Delayed jobs per holdId.        Async webhook simulation       Two-phase refund execution.
  Queue delivery is only a        (success, failure, delay,      Committed separately:
  wake-up; SQL now() decides.     duplicates, out-of-order).     'processing' -> 'refunded'.

                                  4. payment-reconciliation
                                  [ Concurrency: 1 ]
                                  Repeated every 30s. Scans Postgres for orphaned
                                  payment attempts and unhandled refunds.
```

1. **`hold-expiry` (Concurrency: 1):**
   When a hold is created, the API schedules a delayed BullMQ job with `jobId = hold.id` set to run in 300 seconds. When BullMQ fires, the worker executes `cleanup_expired_hold(hold_id)` in PostgreSQL.
2. **`payment-events` (Concurrency: 32):**
   Handles payment simulation jobs. A high concurrency of 32 allows the worker to simulate parallel webhooks for dozens of contending customers without head-of-line blocking.
3. **`refunds` (Concurrency: 8):**
   Processes `refund_required` rows resulting from late payment approvals. Operates in two distinct phases (`processing` then `refunded`) so that a crash during bank settlement simulation leaves a clear audit trail.
4. **`payment-reconciliation` (Concurrency: 1):**
   A repeatable singleton job executed every 30 seconds to drive the database reconciliation loop.

---

### 3.2 The "Belt and Suspenders" Resilience Pattern

> **Core Philosophy:** *Queue delivery is strictly an optimization, never an authority.*

Why can't we rely solely on BullMQ delayed jobs to expire holds?
- If Redis restarts with an uncommitted AOF buffer, delayed jobs are lost.
- If the Redis network connection drops for 10 minutes, delayed jobs do not fire.
- If the worker daemon experiences high CPU thrashing, timer execution drifts.

To guarantee that inventory is never permanently leaked, SeatRush implements a dual-layer **"Belt and Suspenders"** recovery loop:

```mermaid
flowchart TD
    classDef fast fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#0f172a;
    classDef healing fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#0f172a;
    classDef db fill:#ede9fe,stroke:#7c3aed,stroke-width:1.5px,color:#0f172a;
    classDef decision fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#0f172a;
    classDef terminal fill:#f1f5f9,stroke:#475569,stroke-width:1.5px,color:#0f172a;

    subgraph FastPath["Branch 1: The Fast Path (Event-Driven BullMQ Delayed Jobs)"]
        H1["Hold Created at T=0<br/>(5-Minute Expiry Window)"]:::fast
        Q[("BullMQ: hold-expiry Queue<br/>(Redis 8 AOF Transport / delay: 5m)")]:::fast
        W1["BullMQ Expiry Worker<br/>(Job fires precisely at T=5m)"]:::fast
        
        H1 -->|"1a. Best-effort enqueue<br/>(holdId, delay: 300000ms)"| Q
        Q -->|"1b. Delayed job wake-up<br/>Targeted single hold"| W1
    end

    subgraph HealingPath["Branch 2: The Self-Healing Path (30s Database Reconciliation Sweeps)"]
        Timer["Deterministic 30s Timer<br/>(payment-reconciliation queue)"]:::healing
        Sweep["startExpirySweep() Engine<br/>(Scheduled Sweeper Loop)"]:::healing
        Query[("Direct PostgreSQL Query<br/>SELECT id FROM holds WHERE<br/>status = 'active' AND expires_at &lt;= now()")]:::healing
        W2["Reconciliation Sweeper Worker<br/>(Rescues orphaned / stalled holds)"]:::healing

        Timer -->|"2a. 30-second interval pulse"| Sweep
        Sweep -->|"2b. Direct table query<br/>(bypasses Redis state)"| Query
        Query -->|"2c. Batch up to 500 expired IDs"| W2
    end

    subgraph Authority["PostgreSQL Authoritative Kernel (Transactional Guard)"]
        CleanupFn["Stored Procedure: cleanup_expired_hold(p_hold_id)<br/>(Acquires FOR NO KEY UPDATE on hold row)"]:::db
        VerifyHold{"Guard Condition:<br/>status == 'active'<br/>AND expires_at &lt;= now()?"}:::decision
        Clear[("UPDATE seats<br/>SET current_hold_id = NULL<br/>WHERE current_hold_id = hold_id")]:::db
        UpdateHold["UPDATE holds<br/>SET status = 'expired'"]:::db
        EmitEvent[("INSERT INTO domain_events<br/>(kind: 'hold.expired')")]:::db
        Restored(["Seats Restored to Live Pool<br/>Available for Immediate Re-Hold"]):::terminal
        NoOp(["NO-OP Safe Return<br/>(Zero Mutations / Anti-Corruption)"]):::terminal

        W1 -->|"Pass hold_id"| CleanupFn
        W2 -->|"Pass hold_id"| CleanupFn

        CleanupFn --> VerifyHold
        VerifyHold -->|"YES: Window Has Expired"| Clear
        Clear --> UpdateHold
        UpdateHold --> EmitEvent
        EmitEvent --> Restored
        
        VerifyHold -->|"NO: Early Wake-up<br/>or Already Cleaned"| NoOp
    end
```

1. **Branch 1 (The Suspender - Fast Path):** BullMQ delivers the delayed job right on the 5-minute mark, instantly releasing the seats.
2. **Branch 2 (The Belt - Self-Healing Safety Net):** Every 30 seconds, `startExpirySweep()` queries the database directly:
   ```sql
   SELECT id FROM holds
   WHERE status = 'active' AND expires_at <= now()
   ORDER BY expires_at, id
   LIMIT 500;
   ```
   Even if Redis was wiped completely, the sweeper discovers expired holds and cleans them up within 30 seconds.
3. **The Guard Condition in SQL:**
   Crucially, `cleanup_expired_hold` does not blindly trust either caller:
   ```sql
   SELECT old.* INTO h FROM holds old WHERE old.id = p_hold_id FOR NO KEY UPDATE;
   IF NOT FOUND OR h.status <> 'active' OR h.expires_at > now() THEN
     RETURN; -- No-op: Hold is either already cleaned or still valid
   END IF;
   ```
   If a delayed job arrives early due to client clock drift, PostgreSQL checks its own clock (`now()`). If the hold is not yet expired, the transaction exits without touching seat ownership, and the worker re-schedules the job.

---

### 3.3 Failure Modes & Chaos Engineering Analysis

| Failure Mode | Direct Impact | Systems Engineering Recovery Mechanism |
|---|---|---|
| **Redis Crashes or Wiped** | BullMQ queue data and pub/sub channels are temporarily lost. | **Zero inventory corruption.** PostgreSQL holds all seat ownership. When Redis restarts, the worker's connection listener reconnects automatically. The 30-second sweeper detects all expired holds and pending refunds directly from PostgreSQL tables and re-enqueues them. |
| **Worker Process Killed (SIGKILL / OOM)** | In-flight payment simulations or refund jobs terminate mid-execution. | The shutdown handler (`apps/worker/src/index.ts`) traps `SIGTERM`/`SIGINT` with a 9-second deadline before Docker's 10-second SIGKILL. If forcefully killed, unapplied payment attempts remain in status `initiated`. The sweeper (`findStalledPaymentAttempts`) identifies attempts older than 30 seconds and safely resumes them. |
| **API Process Crashes During Hold Creation** | A client request terminates while holding an idempotency lease. | The `idempotency_records` table holds a `locked_until = now() + interval '30 seconds'` lease. After 30 seconds, the stale lease can be safely taken over by a retried request with the matching request hash. |
| **PostgreSQL Serialization Deadlock (`40001` / `40P01`)** | Under intense concurrent contention, two transactions collide on index pages. | The API wraps transactional operations in `withDbRetry()`. If `classifyDbError()` identifies SQLSTATE `40001` (serialization failure) or `40P01` (deadlock detected), the entire transaction is automatically retried once from the beginning with a fresh snapshot. |

---

## 4. Hands-on Inspection & Verification Cheatsheet

As a systems engineer, you should never trust documentation without verifying the runtime state yourself. Below are practical commands to inspect the live database, run invariant audits, and test API endpoints directly.

### 4.1 Live PostgreSQL Inspection Queries

Connect to the PostgreSQL instance via `psql`:
```bash
psql postgresql://seatrush:seatrush@localhost:5433/seatrush
```

#### Query 1: Real-Time Seat Inventory Partitioning
Verify that all 100 seats strictly partition into `available`, `held`, and `confirmed`:
```sql
SELECT 
  count(*) FILTER (WHERE s.current_hold_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id)) AS available,
  count(*) FILTER (WHERE h.status = 'active' AND h.expires_at > now()) AS actively_held,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM booked_seats bs WHERE bs.seat_id = s.id)) AS confirmed_booked,
  count(*) AS total_seats
FROM seats s
LEFT JOIN holds h ON h.id = s.current_hold_id;
```
*(Expected output: sum of available + actively_held + confirmed_booked must equal exactly 100).*

#### Query 2: Inspect Active Holds with Real Expiry Deadlines
```sql
SELECT 
  h.id AS hold_id,
  i.display_name AS customer,
  h.seat_count,
  h.amount_paise / 100.0 AS amount_inr,
  h.status,
  h.expires_at,
  round(extract(epoch FROM (h.expires_at - now()))::numeric, 1) AS seconds_remaining
FROM holds h
JOIN identities i ON i.id = h.customer_id
WHERE h.status = 'active' AND h.expires_at > now()
ORDER BY h.expires_at ASC;
```

#### Query 3: Inspect Payment Attempts & Outcomes
```sql
SELECT 
  a.id AS attempt_id,
  a.scenario,
  a.status AS attempt_status,
  a.amount_paise / 100.0 AS amount_inr,
  e.outcome AS webhook_outcome,
  e.disposition AS webhook_disposition,
  r.status AS refund_status
FROM payment_attempts a
LEFT JOIN payment_events e ON e.payment_attempt_id = a.id
LEFT JOIN refund_required r ON r.payment_attempt_id = a.id
ORDER BY a.created_at DESC LIMIT 10;
```

#### Query 4: Tail the Monotonic Domain Event Log
```sql
SELECT 
  id AS sequence_id,
  screening_id,
  kind,
  payload->>'holdId' AS hold_id,
  created_at
FROM domain_events
ORDER BY id DESC LIMIT 15;
```

---

### 4.2 Automated Invariant Checker (`checkSeatInvariants`)

SeatRush includes an automated invariant verification engine in `packages/db/src/invariants.ts`. In a single atomic CTE snapshot, it checks 12 database integrity constraints:
- Ensures total seats equal 100.
- Confirms zero overlapping active holds.
- Ensures no confirmed seat is actively held.
- Asserts that every confirmed hold has an identical booking record and matching ticket counts.
- Verifies that no payment attempt has both a booking and a refund.

#### Running via Vitest Integration Suite:
```bash
# Run the database ownership and invariant test suite
pnpm --filter @seatrush/db test tests/ownership.test.ts
```

#### Running Invariant Check Manually via TypeScript:
You can execute an immediate invariant check against the live database from your terminal:
```bash
node --loader tsx --env-file=.env -e "
import { createPrismaClient, checkSeatInvariants } from '@seatrush/db';
const prisma = createPrismaClient(process.env.DATABASE_URL);
const screening = await prisma.screening.findUnique({ where: { demoKey: 'demo-screening' } });
const report = await checkSeatInvariants(prisma, screening.id);
console.log(JSON.stringify(report, null, 2));
await prisma.\$disconnect();
"
```
*Expected Output:*
```json
{
  "ok": true,
  "counts": {
    "available": 97,
    "held": 3,
    "confirmed": 0
  },
  "violations": []
}
```

---

### 4.3 Direct API Verification with `curl`

You can test the entire lifecycle directly from the command line without opening a browser.

#### Step 1: Issue a Fresh Demo Customer Session
```bash
SESSION_RESP=$(curl -s -X POST http://localhost:4000/auth/demo-session \
  -H "Content-Type: application/json" \
  -d '{}')

TOKEN=$(echo $SESSION_RESP | jq -r '.token')
CUSTOMER_ID=$(echo $SESSION_RESP | jq -r '.customer.id')
echo "Token: $TOKEN"
```

#### Step 2: Fetch the Demo Screening and Snapshot
```bash
SCREENING_ID=$(curl -s http://localhost:4000/screenings/demo | jq -r '.screeningId')
echo "Screening ID: $SCREENING_ID"

# Inspect the 100-seat snapshot
curl -s http://localhost:4000/screenings/$SCREENING_ID/snapshot \
  -H "Authorization: Bearer $TOKEN" | jq '{totalSeats: (.seats | length), serverTime: .serverTime}'
```

#### Step 3: Claim an Atomic Hold on Seats A1 and A2
```bash
# Grab UUIDs for seats A1 and A2 from the database or snapshot
SEAT_A1=$(curl -s http://localhost:4000/screenings/$SCREENING_ID/snapshot | jq -r '.seats[] | select(.label=="A1") | .id')
SEAT_A2=$(curl -s http://localhost:4000/screenings/$SCREENING_ID/snapshot | jq -r '.seats[] | select(.label=="A2") | .id')

HOLD_RESP=$(curl -s -X POST http://localhost:4000/screenings/$SCREENING_ID/holds \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d "{\"seatIds\": [\"$SEAT_A1\", \"$SEAT_A2\"]}")

HOLD_ID=$(echo $HOLD_RESP | jq -r '.id')
echo "Hold ID: $HOLD_ID"
echo $HOLD_RESP | jq '{status: .status, amountPaise: .amountPaise, expiresAt: .expiresAt}'
```

#### Step 4: Start a Payment Simulation (`success` scenario)
```bash
PAYMENT_RESP=$(curl -s -X POST http://localhost:4000/holds/$HOLD_ID/payments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"scenario": "success"}')

PAYMENT_ID=$(echo $PAYMENT_RESP | jq -r '.id')
echo "Payment Attempt ID: $PAYMENT_ID"
```

#### Step 5: Check Payment Status and Confirmed Booking
Wait 1 second for the worker to deliver the simulation webhook:
```bash
sleep 1
PAYMENT_STATUS=$(curl -s http://localhost:4000/payments/$PAYMENT_ID \
  -H "Authorization: Bearer $TOKEN")

BOOKING_ID=$(echo $PAYMENT_STATUS | jq -r '.bookingId')
echo "Booking ID: $BOOKING_ID"

# Fetch full booking details with ticket codes
curl -s http://localhost:4000/bookings/$BOOKING_ID \
  -H "Authorization: Bearer $TOKEN" | jq '{reference: .reference, amountPaise: .amountPaise, tickets: .tickets}'
```

#### Step 6: Explicitly Release a Hold (Alternative Path)
If you hold a seat and decide not to buy it:
```bash
curl -s -X DELETE http://localhost:4000/holds/$HOLD_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" | jq .
```
*(PostgreSQL immediately sets `current_hold_id = NULL` on the seats and emits a `hold.released` domain event).*

---

## 5. Summary: Lessons in Systems Engineering

By studying SeatRush, you have seen how production systems survive the real world:

1. **Database as Governor:** Never let distributed workers, microservices, or caching layers decide resource ownership. Always serialize mutations through row locks and atomic conditional updates in a relational engine.
2. **Deterministic Locking Order:** Deadlocks are not random acts of nature; they are the mathematical result of uncoordinated lock acquisition. Sorting resources by primary key prior to locking eliminates deadlocks completely.
3. **Lease-Fenced Idempotency:** Safely handling network retries requires locking the request hash under a short lease, storing responses with HTTP status codes, and fencing concurrent attempts.
4. **Clock Synchronization:** Never trust client timestamps. Always calculate clock offset midpoints to compensate for network latency, and let database triggers assign definitive timestamps.
5. **Belt-and-Suspenders Resilience:** Background queues are fast, but database sweepers ensure eventual consistency if queues fail or restart.
6. **Absorbing State Machines:** Financial state transitions must be monotonic and immutable once terminal. Late payments must trigger automated refunds rather than corrupting inventory.
