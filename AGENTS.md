# SeatRush

Cinema booking system: 1,000 simulated customers race for 100 seats; a live dashboard shows that ownership stays correct. Requirements: `prd.md` (source of truth; cite sections like FR-02, §13).

## Layout

| Path | Package | Role |
|---|---|---|
| `packages/shared` | `@seatrush/shared` | Domain constants, zod request/response schemas, SSE event types. No I/O. |
| `packages/db` | `@seatrush/db` | Prisma schema, SQL migrations, seed, Prisma client factory, invariant checks. |
| `apps/api` | `@seatrush/api` | Express 5 HTTP API + SSE. Port 4000. |
| `apps/worker` | `@seatrush/worker` | BullMQ worker: expiry tidy-up, payment-event delivery, refunds. |
| `apps/web` | `@seatrush/web` | Next.js customer UI + operator dashboard. Port 3000. |
| `infra/` | | Docker Compose init scripts. |

Internal packages export TypeScript source under the `development` condition and `dist/` otherwise. Dev and test runs use `--conditions=development` (tsx) / `resolve.conditions` (Vitest); `pnpm build` compiles in dependency order.

## Commands

```bash
pnpm infra:up                                # Postgres 18 (host :5433) + Redis 8 (:6379)
pnpm --filter @seatrush/db migrate:deploy    # apply migrations to DATABASE_URL
pnpm --filter @seatrush/db seed
pnpm typecheck && pnpm test && pnpm build
```

`.env` (copied from `.env.example`) holds `DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_URL`, `AUTH_TOKEN_SECRET`. Never commit it. Integration tests use `TEST_DATABASE_URL` only.

Adding dependencies while other agents work: serialize on the lockfile with `flock /tmp/seatrush-pnpm.lock pnpm --filter <pkg> add <dep>`. Pin exact versions for Prisma (7.10.1, not 8.x RC), TypeScript (6.0.3), Vitest (5.1.0), Next (16.4.5).

## Correctness invariants (never trade these for convenience)

- PostgreSQL is the only authority for seat ownership. Redis/BullMQ never decide whether a seat can be sold.
- Expiry is decided by the database clock (`now()` inside the deciding transaction), never by app-server time.
- A hold with `expires_at <= now()` is non-blocking for every seat-claim query, whether or not cleanup has run.
- Hold creation is all-or-nothing; a unique constraint on confirmed (screening, seat) is the last guard against double sale.
- Payment attempt states `initiated → succeeded | failed` are absorbing once final. Success after expiry or release produces a refund-required record, never a reclaim.
- Booking changes and their outbox/event rows commit in the same transaction.
- Money is integer paise. The server computes every amount.
- Concurrency-critical statements use raw SQL (`$queryRaw` / `$executeRaw` inside `$transaction`), not the generic query builder.

## Conventions

- TypeScript strict, ESM, NodeNext; relative imports end in `.js`.
- Validate every request with zod schemas from `@seatrush/shared`; OpenAPI is generated from those same schemas.
- Every request carries a correlation id (`x-request-id`); logs never include tokens or payment details.
- Tests: Vitest. Concurrency tests run real parallel requests against a real Postgres (`TEST_DATABASE_URL`); no mocks of the database in correctness tests.

## Agent workflow

Two models cross-check each other: `openai-codex/gpt-6.1-sol` owns the backend concurrency core (schema, holds, expiry, payments, idempotency) and reviews frontend/infra work; `anthropic/claude-opus-5-5` coordinates and owns frontend, simulator, infra and docs, and reviews the core. Work that touches the invariants above is reviewed by the other model before merge.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `YuvvrajSingh/seat-rush`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Frontend and visuals

- Any UI work: run `unslop` (audit, then direction, then passes) together with `frontend-design`, `web-design-guidelines` and `react-best-practices`. A screen isn't done until it passes the unslop audit.
- WebGL: `threejs-react-three-fiber` first, plus `threejs-shaders`, `threejs-postprocessing`, `threejs-performance` and `threejs-interaction` as needed. Every visual event must come from a real backend event (prd §9), and every canvas needs an accessible DOM equivalent and a reduced-motion path.
- Bitmap assets: `imagegen` (OpenAI gpt-image), run through the Codex CLI's built-in image tool (`codex exec`, ChatGPT login; no API key needed). Show the prompt and get approval before generating. Final assets go in `apps/web/public/` with their prompts recorded in `docs/assets.md`.
- Third-party skill licenses: `unslop` is CC BY 4.0 (Damir Sokolovsky, github.com/heydamir/unslop); three.js skills are MIT (`.agents/skills/LICENSE.threejs-skills`); Matt Pocock skills are MIT (`.agents/skills/LICENSE.mattpocock`).
