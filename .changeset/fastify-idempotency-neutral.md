---
"@basaltkit/fastify": minor
---

`idempotencyPlugin`, `MemoryIdempotencyStore` and `RedisIdempotencyStore` are now re-exported from `@basaltkit/http`, where idempotency runs in the shared route pipeline on every adapter (BK-084e); existing imports and defaults are unchanged and gain the opt-in `fingerprint` and `replayAfterGuards` options. Behaviour change to note: the plugin no longer depends on `basalt:fastify`, and it covers Basalt `route()` definitions only — a handler registered directly on the Fastify instance (outside `fastifyPlugin({ routes })`) is no longer guarded by it. `RedisLike` stays exported as a deprecated alias of `RedisIdempotencyClient`.
