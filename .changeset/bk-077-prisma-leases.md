---
"@basaltkit/prisma": minor
---

Fix (BK-077): `prismaPlugin` now **leases** the tenant client for each HTTP request and each `tenancy.run()` instead of handing it out with `pool.get()`. Before, a client counted as "in use" for `idleMs` (30 s) after every request, so on defaults the 11th distinct tenant within 30 s waited 10 s and got a 503 `PRISMA_POOL_EXHAUSTED` while nothing was running.

- HTTP: the plugin's enricher returns a disposer that releases the lease once the response has ended (streams, event streams, errors and client aborts included, on Fastify, Express and Hono). Exactly one lease per request, whichever order tenancy and prisma are registered in.
- `tenancy.run()`: leased on `tenancy:switched` (`via: 'run'`), released on `tenancy:exited`; nested runs get their own lease and leave the outer client untouched. A `tenancy:switched` without `via` (an older `@basaltkit/tenancy`, a hand-rolled emit) keeps the previous time-based hand-out.
- The pool the plugin builds defaults `idleMs` to 1 000 ms (a grace period, no longer a request budget). `TenantClientPool`'s own default (30 s) and `DB_POOL.get()` are unchanged.
- `TenantPoolExhaustedError` details gain `leased` and `recentlyUsed`, and the message advises "raise `max`" or "lower `idleMs`" accordingly.

Upgrade note: if you relied on `DB_POOL.get()` against the plugin's pool for work longer than 1 s, use `DB_POOL.use()`/`acquire()` or pass `idleMs` explicitly. Upgrade `@basaltkit/tenancy` alongside to get leasing inside `tenancy.run()`.
