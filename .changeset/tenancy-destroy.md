---
'@basaltkit/tenancy': minor
'@basaltkit/tenancy-prisma': minor
'@basaltkit/tenancy-sqlite': minor
'@basaltkit/testing': minor
---

A tenant can be removed.

`TenantSource` had `find`, `findByDomain`, `list`, `create` and `save`, and
`Tenancy` had no `destroy`. There was no path out — not even an optional one.
Two things followed.

In tests, isolation suites reached for raw SQL:
`$executeRawUnsafe('DROP SCHEMA "tenant_' + id + '" CASCADE')`. It normalises
string interpolation into an SQL identifier, and the reason it was needed is
worse than the pattern: without that cleanup, a schema left by a failed run
makes the next provisioning a no-op, and every assertion below it passes green
against the previous run's data. The suite stops testing anything and says
nothing.

In production, a self-serve signup that failed halfway left a PostgreSQL schema
that nothing in the framework could remove.

```ts
tenancyPlugin({ source, resolvers, onProvision, onDeprovision })

await tenancy.destroy('acme')
await tenancy.destroy('acme', { force: true })
```

```bash
basalt tenant:destroy acme          # asks first
basalt tenant:destroy acme --yes    # for scripts
```

**The order of operations is the design**, and each step is where it is because
the alternative loses something:

1. **Mark `deleting`** — a new `TenantStatus`, so the resolver answers 503 and
   stops routing before anything is torn down. Dropping a schema out from under
   live requests produces errors nobody can interpret, from a tenant that looked
   healthy a second earlier.
2. **Run `onDeprovision` inside the tenant's context**, exactly like
   `onProvision`, so a tenant-scoped client points at the storage being removed.
3. **Delete the record last.** The record is the only thing naming that storage.
   Delete it first and a failed teardown orphans a schema nobody can find —
   which is the state this method exists to prevent.

If teardown throws, the record survives marked `deleting` and the error
propagates: the evidence is kept and a retry can finish. `force` removes the
record anyway, for when the storage is already gone by other means; it is a
deliberate way to orphan storage, so it is never the default.

A source that cannot delete gets `TenantDeleteUnsupportedError` rather than a
success it did not perform — a tenant that looks removed and still resolves is
worse than one that never left. `MemoryTenantSource`, `tenancy-prisma` and
`tenancy-sqlite` all implement `delete()`; the Prisma and SQLite sources keep
their existing `remove()` as the older name.

**`@basaltkit/testing` gains `withTenant(tenancy, id, fn)`** — provision, run,
clean up, *including when the test throws*, which is the case that matters: a
failing test that leaves its tenant behind makes the next run fail for a
different reason. It also destroys a leftover of the same id before starting,
because a previous run may have died between writing the record and creating the
schema, and a suite should be able to recover on its own.
