---
"@basaltkit/http": minor
---

Idempotency moves into the shared route pipeline (BK-084e): `idempotencyPlugin`, `MemoryIdempotencyStore` and `RedisIdempotencyStore` are now exported from `@basaltkit/http` and behave identically on Fastify, Express and Hono. Two opt-in options: `fingerprint` (`'body'` or a function) binds a key to its request and answers a reused key with `422 IDEMPOTENCY_KEY_REUSED`, also against a request still in flight; `replayAfterGuards: true` runs the check after guards and validation, so a revoked caller gets `401`/`403` instead of the cached success. Streams and event streams are never cached. The `IdempotencyStore` contract grows additively (`setPending(key, { fingerprint })`, `{ pending: true, fingerprint }` from `get()`); existing stores keep working. Scope hashes are unchanged, so records already stored keep replaying.
