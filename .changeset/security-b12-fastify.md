---
'@basaltkit/fastify': minor
---

Security: `idempotencyPlugin` now scopes cached responses by all caller credential headers (`authorization`, `x-session-id`, `cookie`, `x-api-key`, configurable via `credentialHeaders`) plus tenant (`x-tenant-id`, `host`), hashes the scoped key with SHA-256, and no longer caches or replays requests without credentials unless `allowAnonymous: true` — previously a cached response could be replayed to a different or unauthenticated caller. Idempotency keys longer than 255 characters are rejected with `400 IDEMPOTENCY_KEY_INVALID`, and `MemoryIdempotencyStore` now sweeps expired entries and is capped by `maxEntries` (default 10 000).

Only the request that owns the reservation records or releases the outcome: a concurrent `409 IDEMPOTENCY_CONFLICT` can no longer overwrite the in-flight reservation.
