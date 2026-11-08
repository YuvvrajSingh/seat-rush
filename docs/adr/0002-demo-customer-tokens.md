# ADR 0002: Fixed-algorithm signed demo customer sessions

## Context

FR-08 requires seeded demo identities and signed bearer tokens, without registration. The public demo endpoint must not let a browser choose or impersonate an arbitrary identity.

## Decision

`POST /auth/demo-session` accepts an empty request, creates a fresh customer identity with `demo_key = web-<uuid>`, and returns a one-hour signed customer token. Web identities are never reissued, so collecting sessions cannot acquire another visitor's identity. The seeded `customer-NNNN` pool is reserved for the simulator; this supersedes shared-pool web issuance. Fresh identities persist with booking history; this demo does not implement account registration or identity garbage collection.

Tokens use `base64url(JSON claims).base64url(HMAC-SHA256(encoded claims))`, with fixed version 1, customer role, UUID subject and integer expiry. There is no caller-selected algorithm or key. Middleware compares canonical base64url signatures in constant time before parsing claims, bounds token length, checks expiry, and confirms that the identity still exists with the customer role before attaching it to the request. Deletion/reseed or a role change invalidates a session. `AUTH_TOKEN_SECRET` is required and validated at startup. Changing it invalidates all issued tokens; there is no refresh token, revocation store or rotation overlap in Week 1.

Authentication expiry uses the API clock. Seat expiry and every ownership decision remain on the PostgreSQL clock. A supplied invalid bearer token is rejected even on the otherwise anonymous snapshot endpoint. Hold reads and releases are owner-scoped and return 404 for another customer's hold. Authenticated and snapshot responses are marked `Cache-Control: no-store`; request logging redacts authorization and does not log response bodies.

Per prd §12, the public issuance route allows **10 attempts per socket IP per 60-second fixed window**. Attempt 11 returns 429 `rate_limited` with `Retry-After` seconds. The in-memory limiter is per API process, resets on restart, lazily prunes expired windows, and is not a distributed security boundary. Express does not trust forwarded IP headers, so spoofing `X-Forwarded-For` cannot bypass it. Deployments behind a proxy must deliberately configure trusted proxy handling and a distributed limiter before public exposure. Seeded simulation token issuance will be operator-only and must not use this public endpoint.

## Alternatives rejected

Unsigned customer IDs allow impersonation. A JWT dependency and configurable algorithm/key negotiation add machinery unnecessary for this fixed, same-service demo issuer/verifier. A custom compact token is deliberately not advertised as a JWT or intended for cross-service interoperability.

## Consequences

The shared booking schemas generate the OpenAPI routes, including explicit failure statuses. Hold creation and release write seat-attributed domain events in their ownership transaction; snapshots read ownership, per-seat live hold metadata, viewer hold, database time and the committed screening cursor in one SQL statement (ADR 0001). SQL claim conflicts include exact locked conflicting IDs in both message and detail because Prisma's driver adapter may discard PostgreSQL detail. Deadlock/serialization failures retry the entire transaction once, then return `retry_later`; ownership errors are not retried. Database unavailability and pool/connection timeouts return controlled 503 responses.

The API uses `API_DB_POOL_MAX` (default 20) for request-path Prisma connections, independently from the single-connection readiness pool. Operator authentication, idempotency, expiry processing and SSE are outside this cutover.
