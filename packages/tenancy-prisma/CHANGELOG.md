# @basaltkit/tenancy-prisma

## 1.1.0

### Minor Changes

- 30abb78: A tenant can be removed.
  
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

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Initial release

- Prisma-backed `TenantSource` for `@basaltkit/tenancy` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryTenantSource`. Bring
  your own `PrismaClient`; ships a reference `schema.prisma` (`Tenant` +
  `TenantDomain`), discoverable by `basalt prisma:sync`.
- `prismaTenantSource(client)` returns a source ready for
  `tenancyPlugin({ source })`, with `save`/`find`/`findByDomain`/`list`/`remove`.
  Open tenant records are stored as JSON; domains are normalized and globally
  unique (rejected up front on conflict). Fails fast when the client lacks the
  `Tenant` model.
