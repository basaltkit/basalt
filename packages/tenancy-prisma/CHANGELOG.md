# @basaltkit/tenancy-prisma

## 2.1.0

### Minor Changes

- 20f0dea: Durable custom-domain stores, and tenant saves that no longer erase them (BK-042).
  
  - `@basaltkit/tenancy-prisma`: new `PrismaDomainStore` / `prismaDomainStore(client)`, and `@basaltkit/tenancy-sqlite`: new `SqliteDomainStore` / `sqliteDomainStore(db)` — durable `DomainStore`s for `CustomDomains` on the existing `tenant_domains` table. `add()` translates the driver's unique violation into `DomainTakenError` (409); `replace()` is one conditional update, so of two concurrent take-overs exactly one wins.
  - `save()`/`create()` of both tenant sources now diff the domain set instead of deleting and re-inserting it, and never delete a row that carries a verification token. `tenancy.provision()` (re-runnable by design) and every status change used to wipe a verified custom domain and its proof.
  - `findByDomain()` of both sources is fail-closed for claims: a claimed but unverified domain (`victim.com` registered by another tenant) never resolves a request.
  - `@basaltkit/tenancy`: new test-only subpath `@basaltkit/tenancy/testing` with `domainStoreContract(makeStore)`, framework-neutral cases (`node:assert`) every `DomainStore` should pass.
  - `create-basalt`: the scaffolded `TenantDomain` model carries the new columns.
  
  **Migration (additive).** The bundled `TenantDomain` model gains `verificationToken String?`, `verified Boolean @default(true)`, `createdAt DateTime @default(now())` and `verifiedAt DateTime?`. `basalt prisma:sync` only adds missing models — it does not add columns to a `TenantDomain` model your schema already has — so add the four fields to that model by hand (copy them from `@basaltkit/tenancy-prisma/prisma/schema.prisma`), then run `prisma migrate dev`; existing rows become mirror rows and keep resolving. A new app (or one without the model yet) gets them from `prisma:sync`. Until then, an app whose Prisma client is still generated from the old model keeps working — `PrismaTenantSource` never names the new columns in a query; once the client is regenerated from the new model, migrate before deploying it. The SQLite source adds them on open.
  
  `PrismaTenancyDelegates.tenantDomain` now also requires `findMany` (a generated `PrismaClient` has it; a hand-written client must add it).

## 2.0.0

### Major Changes

- e53db52: Framework audit, pass 2 — persistent stores (FA-068, FA-069, FA-070).
  
  Major for tenancy-prisma, webhooks-prisma, webhooks-sqlite and auth-prisma: a generated PrismaClient still fits the new client interfaces (`$transaction`, `create`/`updateMany`), but hand-written clients and test fakes must add those methods, and cross-scope writes that used to succeed now throw.
  
  - **tenancy-prisma — `save()` / `create()` are atomic (FA-068).** The tenant
    row, the domain check and the domain set (`deleteMany` + `createMany`) now
    run in one interactive `$transaction`. Before, any failure after the delete —
    a domain listed twice, a domain another tenant claimed between the
    pre-flight and the insert, a lost connection — left the tenant rewritten with
    its existing domains gone. Duplicate domains in the array are stored once.
    `PrismaTenancyClient` now includes `$transaction` (a generated
    `PrismaClient` has it; a hand-written client must add it).
  - **webhooks-prisma — writes are keyed by `(id, tenantId)` (FA-069).**
    `add()` was an upsert by `id` alone: on MySQL's case-insensitive collation
    tenant A re-registering `ABC` rewrote tenant B's `abc` endpoint (url,
    secret, tenant). It is now an `updateMany` scoped to the endpoint's own
    tenant (or global scope), falling back to `create`; an id held by another
    scope throws the new `WebhookEndpointIdInUseError` (409). Re-adding an id in
    its own scope still replaces it. `PrismaWebhooksClient` now needs
    `create`/`updateMany` instead of `upsert` (a generated `PrismaClient` has
    them).
  - **webhooks-sqlite — no `INSERT OR REPLACE` across scopes (FA-070/D8).** The
    manager's check-before-write cannot stop two tenants registering the same id
    at once; the store now refuses an id held by another scope with
    `WebhookEndpointIdInUseError` (409) instead of overwriting that endpoint.
  - **auth-prisma — `touch()`/`revoke()` of a missing API key are no-ops
    (FA-070/I4)**, as in the other stores, instead of a Prisma `P2025` thrown
    out of `verify()`. The client surface uses `authApiKey.updateMany` (no longer
    `update`).
  - **auth-sqlite — email uniqueness without the NOCASE index (FA-070/D9).** A
    legacy database holding case-variant duplicates cannot build the
    case-insensitive unique index, and `migrate()` skipped it silently; `create`
    now refuses an email that exists in any letter case inside the `INSERT`
    itself, throwing `EmailTakenError` (409) — also for the race between two
    concurrent sign-ups.
  - **files-prisma — `prismaFilesStore()` fails fast** when the client has no
    `file` model, like every other `*-prisma` factory (FA-070/I4).
  - **permissions-sqlite — multi-permission grants are all-or-nothing**
    (FA-070/I5): `grantToRole` / `grantToUser` run in one savepoint.

### Minor Changes

- b69ea05: MySQL no longer truncates long values silently (framework audit FA-070).
  
  On MySQL Prisma maps a bare `String` to `VARCHAR(191)`, and a server outside
  strict mode cuts a longer value with only a warning: a webhook URL delivered
  elsewhere, a file `path` stopped naming its object, JSON payloads stopped
  parsing, and a truncated audit payload or hash broke the hash chain for good.
  
  - Each package ships **`schema.mysql.prisma`** (exported as
    `@basaltkit/<pkg>/schema.mysql.prisma`): the same models with the free-text
    columns widened (`@db.Text`, `@db.MediumText`, `@db.VarChar(255)`) and the
    keys left at `VARCHAR(191)`. `comments-prisma`'s variant stores `mentions` as
    `Json` (MySQL has no scalar lists); the store now reads either form.
  - Every factory and store class takes an optional **`columnLimits`**
    (`'mysql'` — the preset matching that schema, exported as
    `<domain>MysqlColumnLimits` — or your own per-model limits, in characters or
    `{ bytes }`). With it set, a value longer than its column is refused with
    `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, 422) before anything is
    written. The outbox's diagnostic `lastError` is shortened (marked
    `…[truncated]`) instead, so `markFailed` still counts the attempt.
  - `basalt prisma:sync` (`@basaltkit/prisma`) copies the MySQL variant when the
    app's `datasource` provider is `mysql`, and warns about a package without one.
  
  Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
  calls keep their signatures (the option is a new trailing parameter).

### Patch Changes

- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/tenancy@3.0.0

## 1.2.1

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/tenancy@2.0.0

## 1.2.0

### Minor Changes

- 9dd1dbc: `tenancy.create()` refuses a tenant id that already exists with the new `TenantAlreadyExistsError` (`TENANT_ALREADY_EXISTS`, HTTP 409): nothing is written, no hook fires and `onProvision` does not run. When the existing tenant is `failed` or `provisioning`, the message points at `tenancy.provision(id)`. `PrismaTenantSource` and `SqliteTenantSource` gain an insert-only `create()` that maps the unique violation to that error, so concurrent creates of the same id have exactly one winner; `MemoryTenantSource.create()` now refuses duplicates too, and `basalt tenant:create` reports an existing id with exit code 1.
  
  **Behaviour change:** `create()` no longer overwrites an existing tenant. Previously it fell back to the durable sources' `save()` upsert and replaced the whole record (owner, status, domains) and re-ran provisioning. Use `save()` for an intentional upsert and `provision(id)` to retry a failed tenant. `PrismaTenancyClient['tenant']` now also requires `create` — a generated `PrismaClient` already has it; only a hand-written fake needs the method added.

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
