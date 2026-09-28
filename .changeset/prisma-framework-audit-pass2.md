---
"@basaltkit/prisma": major
---

Framework audit, pass 2 (FA-067, FA-070).

- **Breaking — the per-tenant pool never evicts a client in use (FA-067).**
  `TenantClientPool` used to evict by recency alone: with more active tenants
  than `max`, a client still serving a request was `$disconnect()`ed under it,
  its in-flight queries failed, and Prisma reconnected it *outside* the pool,
  where nothing bounded or closed it again. Now only **idle** clients are
  evicted: a client handed out by `get()` (what `prismaPlugin` does per
  request) counts as in use for `idleMs` (default 30 s), and a client held
  through the new `acquire()` / `use()` leases is never evicted until
  released. When all `max` clients are in use, a new tenant waits up to
  `acquireTimeoutMs` (default 10 s) and then fails with the new
  `TenantPoolExhaustedError` (`PRISMA_POOL_EXHAUSTED`, 503) — the cap is never
  exceeded. Concurrent creations now count against `max` too.
  **Migration:** size `max` for the number of tenants active *at the same
  time* (it used to be survivable to undersize it; it now answers 503). Keep
  `idleMs` above your longest request, or run long work in
  `pool.use(tenantId, fn)`. `prismaPlugin` takes `idleMs` and
  `acquireTimeoutMs`. `new TenantClientPool({ …, idleMs: 0 })` restores
  evict-on-the-spot for callers that manage their own clients.
- **Breaking — RLS policy predicate (FA-070/I3).** `rlsPolicySql` and
  `rlsSearchFunctionSql` now compare against
  `NULLIF(current_setting('<setting>', true), '')`. Once a pooled session has
  set the tenant in any transaction, `current_setting(…, true)` returns `''`
  (not `NULL`) afterwards, so the old policy matched rows whose tenant column
  is `''` for a session with no tenant. **Migration:** re-run the generated
  SQL (both are idempotent) in a new migration.
- **`tenancy:switched` fails closed without a client (FA-070/D4).**
  `tenancy.run(B)` copies the surrounding context; when the plugin has no
  client for `B` (e.g. `resolveClient` returned `undefined`), the outer
  tenant's `ctx.db` used to stay in place and `B`'s writes landed in `A`'s
  database. It is now cleared, so `db()` throws `DbUnavailableError`.
- **Class instances (DTOs) are scoped like plain objects (FA-070/D5).** Prisma
  serialises any object argument by its enumerable keys; the tenant scoper
  only recognised plain objects, so a DTO as `data` skipped the
  cross-tenant-write check (a row could be moved to another tenant), a DTO in
  a nested `connect`/`where` ran unscoped, and a DTO `create` lost every field
  but the tenant. They are now read the way Prisma reads them.
