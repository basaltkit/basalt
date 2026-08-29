<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/tenancy-sqlite

Durable, SQLite-backed implementation of the [`@basaltkit/tenancy`](https://github.com/basaltkit/basalt/tree/main/packages/tenancy) `TenantSource`, on Node's built-in `node:sqlite`. Zero external dependencies.

`@basaltkit/tenancy` ships an in-memory `MemoryTenantSource` — perfect for tests and dev, but it forgets every tenant when the process exits. This package is the drop-in durable replacement for a single node: your tenant registry (and their custom domains) survives a restart. The production, multi-instance counterpart is [`@basaltkit/tenancy-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/tenancy-prisma).

## Installation

```bash
pnpm add @basaltkit/tenancy @basaltkit/tenancy-sqlite
```

Requires **Node 22.5+** (`node:sqlite` is stable and flag-free on Node 24; on Node 22.x run with `--experimental-sqlite`).

## Usage

`sqliteTenantSource()` opens (or creates) the database, applies an idempotent schema, and returns a `TenantSource` you pass straight to `tenancyPlugin`:

```ts
import { tenancyPlugin, subdomainResolver } from '@basaltkit/tenancy'
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'

const tenants = sqliteTenantSource('./data/tenants.db') // ':memory:' by default

// Register/seed a tenant (survives a restart).
await tenants.save({ id: 'acme', name: 'Acme Inc', domains: ['app.acme.com'] })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'localhost' })],
})
```

## The model

A tenant is an **open record** — `{ id, ...anything }` — so it's stored as a JSON blob keyed by `id`; you can attach whatever per-tenant fields you like (plan, name, settings…) and they round-trip unchanged. Custom domains (`tenant.domains: string[]`) are mirrored into a normalized, indexed `tenant_domains` table so `findByDomain` (used by the domain resolver) is a keyed lookup, not a scan.

## API

`SqliteTenantSource` implements the full `TenantSource` contract plus write methods:

| Method | Description |
| --- | --- |
| `save(tenant)` | Insert or update a tenant and replace its domain set, in one transaction. |
| `find(id)` | The tenant record, or `null`. |
| `findByDomain(domain)` | The tenant owning that custom domain, or `null`. |
| `list()` | Every tenant, ordered by `id`. |
| `remove(id)` | Delete a tenant and its domains; returns whether one existed. |

`source.db` exposes the raw `DatabaseSync` handle for advanced use.

Other exports:

| Export | Kind | Purpose |
| --- | --- | --- |
| `sqliteTenantSource(dbOrLocation?)` | function | Opens (or reuses) a database, applies the schema, returns a `SqliteTenantSource`. Defaults to `':memory:'`. |
| `SqliteTenantSource` | class | The implementation. `new SqliteTenantSource(db)` to share a handle with the other `*-sqlite` stores. |
| `openTenancyDatabase(location?)` | function | Opens a `DatabaseSync` and migrates it. |
| `migrate(db)` | function | Applies the idempotent schema to an existing handle. |

`sqliteTenantSource` accepts a single argument — a path or an existing
`DatabaseSync` — and has no options object. `migrate()` sets
`journal_mode = WAL` and `busy_timeout = 5000`, so a competing writer waits up
to 5 s for the lock instead of throwing "database is locked" immediately.

**Domains are globally unique.** Claiming a domain already owned by a *different* tenant throws, and the whole `save` rolls back — routing must be unambiguous, and the tenant record and its domains never drift apart. Re-saving the *same* tenant with a new `domains` array adds the new ones and drops the missing ones.

## Errors

This package defines no `BasaltError` subclasses and no error codes.
`node:sqlite` errors propagate unchanged — including the `UNIQUE` violation
raised when `save()` claims a domain already owned by a different tenant, which
rolls the whole transaction back. The tenancy errors a client sees —
`TENANT_REQUIRED`, `TENANCY_NOT_RESOLVED`, `TENANT_NOT_FOUND` — come from
`@basaltkit/tenancy`.

On Node 22.x, importing this package without `--experimental-sqlite` fails at
load with an unknown-builtin error for `node:sqlite`. Node 24 needs no flag.

## Hooks & events

None. `tenancy:switched` is emitted by `@basaltkit/tenancy`.

## Which backend?

- **`@basaltkit/tenancy-sqlite`** — a single node, zero dependencies, the tenant registry in a local file.
- **`@basaltkit/tenancy-prisma`** — you already run Postgres/MySQL, or need several instances to share one tenant registry.

Both implement the identical `TenantSource` contract, so switching is a one-line change.

Guides: [Tenancy](/guide/tenancy) · [Creating a tenant](/guide/creating-a-tenant) · [Persistence](/guide/persistence).
