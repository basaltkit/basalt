---
"@basaltkit/prisma": minor
---

Fix (BK-077): `prismaPlugin` now **leases** the tenant client for each HTTP request and each `tenancy.run()` instead of handing it out with `pool.get()`. Before, a client counted as "in use" for `idleMs` (30 s) after every request, so on defaults the 11th distinct tenant within 30 s waited 10 s and got a 503 `PRISMA_POOL_EXHAUSTED` while nothing was running.

- HTTP (needs `@basaltkit/http` >= 2.8, now declared as an optional peer): the lease is taken as soon as the tenant is known — on the tenancy enricher's `tenancy:switched` or in the plugin's own enricher, whichever runs first — and released through the request's disposer sink (`ctx().onDispose`) once the response has ended (streams, event streams, errors, client aborts and a later enricher or guard rejecting the request included, on Fastify, Express and Hono). Exactly one lease per request, whichever order tenancy, prisma and your own enrichers are registered in; an enricher between `tenancyPlugin` and `prismaPlugin` sees `ctx().db`.
- `tenancy.run()` (needs `@basaltkit/tenancy` >= 3.2): leased on `tenancy:switched` (`via: 'run'`), released on `tenancy:exited`; nested runs get their own lease and leave the outer client untouched.
- Legacy paths keep the old behaviour, 30 s window included: on a pipeline without `ctx().onDispose` (`@basaltkit/http` < 2.8), and for a `tenancy:switched` without `via` (`@basaltkit/tenancy` < 3.2, a hand-rolled emit), the plugin leases nothing it could never give back — it holds the client for 30 s and then returns it on its own, as `pool.get()` did. The same 30 s hand-out applies to a switch emitted on a request (or `tenancy.run()`) context whose owner already ended — a timer the handler left behind, a hook fired after the response — so such a lease is never parked in a slot nothing will release again.
- The pool the plugin builds defaults `idleMs` to 1 000 ms (a grace period, no longer a request budget). `TenantClientPool`'s own default (30 s) and `DB_POOL.get()` are unchanged.
- `TenantPoolExhaustedError` details gain `leased` and `recentlyUsed`, and the message advises "raise `max`" or "lower `idleMs`" accordingly. The error is now `expose: false`: the message and details stay in the server log, and the 503 body only carries the code and "Service unavailable.".

Upgrade notes:

- Upgrade `@basaltkit/http` and your adapter to this release alongside (and `@basaltkit/tenancy` for leasing inside `tenancy.run()`); without them you keep the previous 30 s time-based behaviour.
- `ctx().db` after the response: the request's lease ends with its response, and the client then stays reserved for only 1 s. Work that outlives the reply (a fire-and-forget promise, a handler that answers before awaiting its writes) must `await` before replying or run in `tenancy.run()` / `DB_POOL.use()`.
- If you relied on `DB_POOL.get()` against the plugin's pool for work longer than 1 s, use `DB_POOL.use()`/`acquire()` or pass `idleMs` explicitly.
- Size `max` by the distinct tenants active within a few seconds. Over-subscription no longer answers 503: it churns (an idle client is closed and a new one opened on each request when more tenants than `max` take turns). Monitor client creations (calls to `forTenant`).
