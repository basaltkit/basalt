---
'@basaltkit/prisma': patch
---

Add `tenantClient()` — the per-request client stand-in every schema-per-tenant
app was writing by hand.

The `-prisma` stores (`auth-prisma`, `permissions-prisma`, `audit-prisma`,
`activity-prisma`, `teams-prisma`, `notifications-prisma`) take a client when
they are constructed, at boot, and hold it for the life of the process. Under
schema-per-tenant the right client is only known per request: it comes from
`db()`, which reads the context and throws outside one.

The framework already tolerated the workaround — `ensureModel` catches the "not
yet resolvable" case, commented *"lazy/proxy client (e.g. database-per-tenant) —
validated at first use"* — but never supplied it, so each application wrote the
same proxy:

```ts
// before
const tenantDb = new Proxy({} as PrismaClient, {
  get: (_t, prop) => (db() as Record<string | symbol, unknown>)[prop],
})

// after
const tenantDb = tenantClient<PrismaClient>()
```

Writing that proxy wrong does not raise an error. It points every tenant at
whatever client was passed instead — usually the central one — so tenant data
lands in the `public` schema, silently. The version here also forwards through
`Reflect`, keeping the receiver intact when a store calls a model method, and
answers `has`/`ownKeys`, which is what the stores' model probes rely on.

Not a replacement for `db()`: inside a request, call `db()`. This is for the
places that must be constructed before a request exists.
