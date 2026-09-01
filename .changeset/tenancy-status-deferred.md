---
'@basaltkit/tenancy': minor
---

**A tenant can now say it is not ready yet, and provisioning can outlive the request.**

Completes the provisioning work: 1.5.0 added `onProvision` and `tenancy:created`,
but a tenant was routable the instant its record existed. Between "saved" and
"migrated" it was reachable *and* broken, and the first request died on a raw
database error.

### Status, and a truthful 503

| Status | Serves | How |
| --- | :---: | --- |
| *(none)* | ✅ | Predates this feature — **treated as ready**, so upgrading does not take an estate offline |
| `ready` | ✅ | `onProvision` succeeded |
| `provisioning` | ❌ **503** | Record written, work unfinished |
| `failed` | ❌ **503** | `onProvision` threw; the record is kept as evidence, not deleted |

503 rather than 404: the tenant exists, it simply is not serving, and 503 is the
status a client may retry.

New: `TenantNotReadyError` (`TENANT_NOT_READY`), `TenantStatus`, `isTenantReady()`.

### `provision: 'deferred'`

```ts
tenancyPlugin({ source, resolvers, onProvision, provision: 'deferred' })
```

`create()` then returns as soon as the record is written, marked
`provisioning` — and the resolver already answers 503 for it.

**Nothing is scheduled for you.** Background work runs in another process, where
a closure from this one cannot reach, so the worker re-enters with the id:

```ts
const ProvisionTenant = defineJob({
  name: 'tenant.provision',
  handle: ({ id }: { id: string }) => ctx().container.get(TENANCY).provision(id),
})

await tenancy.create({ id })                    // returns immediately
await queue.dispatch(ProvisionTenant, { id })
```

`tenancy.provision(id)` is public for exactly this: it runs `onProvision`, flips
the status and emits `tenancy:created` — the same finish line the inline path
crosses. It keeps `@basaltkit/queue` out of this package entirely, so any
scheduler works.

### Unchanged by default

`provision` defaults to `'inline'` — existing apps behave exactly as before.
Apps with no `onProvision` get no status stamped at all, because nothing would
ever clear it.

`MemoryTenantSource` gains `save()`, needed for the status transitions.
