# SeatRush

A cinema booking system built to be rushed: up to 1,000 simulated customers compete for 100 seats, and PostgreSQL guarantees no seat is ever sold twice. Requirements live in [`prd.md`](prd.md); design decisions in [`docs/adr/`](docs/adr).

## Status

| Delivery plan (prd §15) | State |
|---|---|
| Week 1: schema, seat map, atomic holds, snapshot, seat events | Done |
| Week 2: expiry worker, idempotency keys, conflict channel | Done |
| Week 3: simulated payments, confirmation, refunds | Done |
| Week 4: operator dashboard, SSE stream, load generator, WebGL seat map | Not started |
| Weeks 5–6: failure tests, deployment, benchmarks | Not started |

What you can run today: the customer booking page (`/book`) with simulated payment, confirmation and a printable ticket; the booking API; and the worker (hold expiry, simulated payment provider, refunds). The operator dashboard and load generator arrive in Week 4.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 (see `.nvmrc`) | |
| pnpm | 12.18 | `corepack enable pnpm` picks the version from `package.json` |
| Docker + Compose | Compose v2+ | runs PostgreSQL 18 and Redis 8; your user must be in the `docker` group |

## Run it locally

```bash
# 1. Install dependencies
corepack enable pnpm
pnpm install

# 2. Configure: one .env at the repo root, read by every app
cp .env.example .env
for name in AUTH_TOKEN_SECRET PAYMENT_WEBHOOK_SECRET; do
  sed -i "s/^$name=.*/$name=$(openssl rand -hex 32)/" .env
done

# 3. Start PostgreSQL (host port 5433) and Redis (6379)
pnpm infra:up

# 4. Create the schema and the demo data (1 screening, 100 seats A1–J10, 1,050 simulator customers)
pnpm --filter @seatrush/db migrate:deploy
pnpm --filter @seatrush/db seed
```

`AUTH_TOKEN_SECRET` and `PAYMENT_WEBHOOK_SECRET` must each be at least 32 characters; the API and worker refuse to start with the template values. The seed is idempotent, so running it twice changes nothing.

Then start the three processes, each in its own terminal:

```bash
pnpm --filter @seatrush/api dev      # API on http://localhost:4000
pnpm --filter @seatrush/worker dev   # worker: hold expiry, simulated payment provider, refunds (no port)
pnpm --filter @seatrush/web dev      # web app on http://localhost:3000
```

Open <http://localhost:3000/book>. The page creates a demo customer for you, shows the live seat map (refreshed every 2 seconds), and lets you hold 1–4 seats, watch the five-minute countdown, pay, and get a booking reference with a printable ticket. Open the page in a second browser profile to act as a competing customer.

Payment is simulated: you choose how the pretend payment provider behaves (approve, decline, approve after a delay, send the same notification twice, deliver notifications out of order, or fail delivery twice before succeeding). The worker plays that behaviour out and sends signed notifications to the API, which decides the outcome in one database transaction. Paying never extends the hold: a payment that succeeds after the hold has ended doesn't book the seats; it creates a refund record that the worker then refunds.

### Production build

```bash
pnpm build
pnpm --filter @seatrush/api start
pnpm --filter @seatrush/worker start
pnpm --filter @seatrush/web start
```

## Try the API from a terminal

The API is documented as OpenAPI 3.1 at <http://localhost:4000/openapi.json>, generated from the same zod schemas the API validates with.

```bash
API=http://localhost:4000

# A demo customer session (each call creates a fresh customer; limit 10 per IP per minute)
TOKEN=$(curl -s -X POST $API/auth/demo-session -H 'content-type: application/json' -d '{}' | jq -r .token)

# The demo screening and its seat map
SCREENING=$(curl -s $API/screenings/demo | jq -r .screeningId)
curl -s $API/screenings/$SCREENING/snapshot | jq '.counts'
A7=$(curl -s $API/screenings/$SCREENING/snapshot | jq -r '.seats[] | select(.label=="A7") | .id')

# Hold A7. Idempotency-Key is required; retrying with the same key returns the same hold.
KEY=$(cat /proc/sys/kernel/random/uuid)   # any unique string; macOS: $(uuidgen)
curl -s -X POST $API/screenings/$SCREENING/holds \
  -H "authorization: Bearer $TOKEN" -H "idempotency-key: $KEY" \
  -H 'content-type: application/json' -d "{\"seatIds\":[\"$A7\"]}" | tee /tmp/hold.json | jq

# Release it
curl -s -X DELETE $API/holds/$(jq -r .id /tmp/hold.json) -H "authorization: Bearer $TOKEN" | jq '.status'
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | – | process is up |
| GET | `/readyz` | – | Postgres and Redis reachable (503 otherwise) |
| POST | `/auth/demo-session` | – | new demo customer + bearer token |
| GET | `/screenings/demo` | – | id of the seeded screening |
| GET | `/screenings/{id}/snapshot` | optional | every seat's state, counts, your hold, last event id, server time |
| POST | `/screenings/{id}/holds` | required | hold 1–4 seats atomically (all or none) |
| GET | `/holds/{id}` | owner | hold status, decided by the database clock |
| DELETE | `/holds/{id}` | owner | release an active hold |
| GET | `/openapi.json` | – | API description |

Errors share one shape: `{"error":{"code","message","requestId"}}`. Every response carries an `x-request-id` header.

## Tests

```bash
DATABASE_URL=$(grep ^TEST_DATABASE_URL .env | cut -d= -f2-) pnpm --filter @seatrush/db migrate:deploy   # once, for the test database
pnpm typecheck
pnpm test        # package suites run one at a time; DB tests use TEST_DATABASE_URL only
pnpm build
```

Integration tests run real parallel requests against real PostgreSQL and Redis, with no database mocks. Among them: 100 customers racing for A7 (exactly one wins), a four-seat request with one taken seat (none held), expiry racing a new claim, concurrent requests with the same idempotency key, and seat-invariant checks after each burst. CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main`.

## Project layout

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@seatrush/shared` | Domain constants, zod request/response/event schemas, env parsing |
| `packages/db` | `@seatrush/db` | Prisma schema, SQL migrations (seat-claim functions and constraints), seed, invariant checks |
| `apps/api` | `@seatrush/api` | Express 5 HTTP API |
| `apps/worker` | `@seatrush/worker` | BullMQ worker: tidies expired holds, plays the simulated payment provider (signed notifications to the API, 3 s timeout, retries with backoff, 32 deliveries at a time), completes refunds, and every 30 s re-queues any unfinished payment or refund whose Redis job was lost or exhausted |
| `apps/web` | `@seatrush/web` | Next.js 16 customer UI |
| `infra/` | | Docker Compose init scripts (creates `seatrush_test`) |

## How seat ownership stays correct

- PostgreSQL alone decides ownership. Redis and the worker only schedule tidy-up; they never decide whether a seat can be sold.
- Expiry uses the database clock. A hold past `expires_at` stops blocking its seats immediately, even before the worker cleans it up.
- Holds are all or nothing, and a unique constraint on confirmed seats is the last guard against a double sale.
- Every ownership change writes its event in the same transaction, with event ids in commit order, so a client can resume from a snapshot without missing anything.

Details: [ADR 0001](docs/adr/0001-seat-ownership-in-postgres.md) (claims, lock order, events) and [ADR 0002](docs/adr/0002-demo-customer-tokens.md) (demo sessions).

## Configuration

All variables live in the root `.env` (see `.env.example`). Never commit it.

| Variable | Used by | Default / example |
|---|---|---|
| `DATABASE_URL` | api, worker, db | `postgresql://seatrush:seatrush@localhost:5433/seatrush` |
| `TEST_DATABASE_URL` | tests | `…/seatrush_test` |
| `REDIS_URL` | api, worker | `redis://localhost:6379` |
| `AUTH_TOKEN_SECRET` | api | required, ≥ 32 characters |
| `PAYMENT_WEBHOOK_SECRET` | api, worker | required, ≥ 32 characters; signs simulated payment notifications |
| `PAYMENT_NOTIFICATION_URL` | worker | `http://localhost:4000/payments/notifications` |
| `API_PORT` | api | `4000` |
| `API_DB_POOL_MAX` | api | `20` |
| `WEB_ORIGIN` | api (CORS) | `http://localhost:3000` |
| `NEXT_PUBLIC_API_URL` | web | `http://localhost:4000` |
| `NEXT_PUBLIC_SITE_URL` | web (Open Graph URLs) | `http://localhost:3000` |
| `LOG_LEVEL` | api, worker | `info` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| API or worker exits with `…_SECRET: must be at least 32 characters` | Generate them: step 2 above |
| `permission denied … docker.sock` | `sudo usermod -aG docker $USER`, then log out and back in |
| Port 5433 or 6379 already in use | Stop the other service, or change the ports in `docker-compose.yml` and `.env` |
| `/readyz` returns 503 / `ECONNREFUSED 6379` | Containers stopped (e.g. after a reboot): `pnpm infra:up` |
| `/book` says sessions are unavailable (429) | The 10-sessions-per-minute limit per IP; wait a minute |
| Start from a clean database | `pnpm infra:down && docker volume rm seatrush_pgdata seatrush_redisdata && pnpm infra:up`, then step 4 |

## License

Third-party agent skills in `.agents/skills/` keep their own licenses (see `AGENTS.md`).
