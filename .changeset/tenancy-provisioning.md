---
'@basaltkit/tenancy': minor
---

**Creating a tenant can now provision its storage automatically.**

Until now `basalt tenant:create` persisted the record and stopped, and the docs
told you to write a `provisionTenant()` helper and remember to call it. That is
operator-shaped: fine when a human runs `basalt tenant:migrate` next, and wrong
for self-service signup, where the person clicking **Create** in a panel has
neither the knowledge nor the access to run a migration. Meanwhile
`subdomainResolver` routes the new tenant's traffic **the moment the record
exists** — so the window between "saved" and "migrated" is a window in which the
tenant is reachable and broken.

### `onProvision` on `tenancyPlugin`

Declared once; runs on every creation path, inside the new tenant's context —
the same contract as the `onMigrate` / `onSeed` hooks it sits beside.

```ts
tenancyPlugin({
  source, resolvers,
  async onProvision(tenant) {
    const admin = new PrismaClient()
    await provisionTenantSchema(admin, tenantSchema(tenant.id))
    await migrateTenants({
      tenants: [tenant.id],
      target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
    })
  },
})
```

### `tenancy.create(tenant)`

The creation path that runs it. Persists → provisions → emits — in that order.

```ts
await ctx().container.get(TENANCY).create({ id: 'acme', name: 'Acme' })
```

`basalt tenant:create` now goes through it too, so the CLI and an admin route
produce an identical tenant. Calling `source.create()` directly still works and
still skips provisioning — the source only writes the row.

### `tenancy:created`

Emitted **after** provisioning succeeds, so a listener may assume the tenant's
storage exists — welcome email, audit entry, notifying a panel.

```ts
app.hooks.on('tenancy:created', ({ tenant }) => notify(tenant))
```

It does not fire if provisioning threw: a listener reacting to a half-built
tenant is worse than one that never runs.

### Known edges, documented rather than hidden

If `onProvision` throws, the error propagates and the hook stays silent — but
**the tenant record already exists**, because the source persists first. That
half-state is deliberately not rolled back: not every `TenantSource` can delete,
and a failed delete on top of a failed provision destroys the evidence. Write
`onProvision` idempotently so a retry finishes the job.

It also runs **inline** — an HTTP handler calling `create()` waits for the
migration. Right for a schema and a few migrations; hand anything slower to a
queued job.

New error: `TenantCreateUnsupportedError` (`TENANT_CREATE_UNSUPPORTED`) for a
read-only `TenantSource`. Purely additive — existing apps are unaffected.
