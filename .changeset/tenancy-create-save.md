---
'@basaltkit/tenancy': patch
---

**Fix: `tenancy.create()` did not work with any durable tenant source.**

Shipped broken in 1.5.0 and found immediately in a real app:

```
TenantCreateUnsupportedError: The configured TenantSource does not implement create().
  at Tenancy.create (@basaltkit/tenancy/dist/index.js:47)
```

…from `@basaltkit/tenancy-prisma`, a source that persists tenants perfectly
well. `create()` required `TenantSource.create()`, but **neither durable source
implements it** — `tenancy-prisma` and `tenancy-sqlite` both expose `save()`, an
upsert with the identical signature. Only `MemoryTenantSource` has `create()`,
so the entire provisioning flow worked only in tests.

`tenancy.create()` now prefers `create()` and falls back to `save()`. `save()` is
also declared on the `TenantSource` contract, which never mentioned it despite
every durable source providing it.

The error message was wrong too — it claimed the Prisma/SQLite sources implement
`create()`. It now names both routes and what each source actually offers.

### Why it was missed

Every test used `MemoryTenantSource` — the one source that happens to have
`create()`. The regression guards added here run against the **real**
`SqliteTenantSource` and `PrismaTenantSource`, because a fake with the right
shape is exactly what failed to catch this.

No API change: `onProvision`, `tenancy:created` and `tenancy.create()` behave as
documented, now on every source that can persist.
