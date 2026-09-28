# @basaltkit/permissions-sqlite

## 2.0.0

### Major Changes

- b69ea05: Framework audit residuals: empty permission segments and malformed store writes.
  
  - **An empty segment never matches.** `permissionMatches('projects:*', 'projects:')` and `permissionMatches('', '')` used to return `true` (the wildcard matched the empty action; equal strings short-circuited). A permission with an empty `:` segment — `''`, `'projects:'`, `':read'`, `'a::b'` — now matches nothing, not even itself, and `'*'` does not cover it. New `hasEmptySegment(permission)` (also on the browser-safe `@basaltkit/permissions/match` entry).
  - **The Gate refuses such permissions.** `can()`, `grantToRole`/`grantToUser`/`grantTemporarily`/`delegate` and `roleCatalog` throw a `TypeError` for a permission with an empty segment, as they already did for whitespace. `MemoryAccessStore.assignRole`/`grantToRole` also refuse an empty or non-string role name.
  - **`SqliteAccessStore` / `PrismaAccessStore` validate direct writes.** `assignRole`, `removeRole`, `grantToRole` and `grantToUser` throw a `TypeError` for an empty or non-string user id, role name or scope, or a permission list that is not an array of non-empty strings — before anything is written. `''`, `null` and `undefined` used to be persisted and shared one "nobody" key.
  
  **Why major:** input that used to be accepted now throws. Migration: find stored grants with an empty segment (`SELECT … WHERE permission LIKE '%:' OR permission LIKE ':%' OR permission LIKE '%::%' OR permission = ''`) — they never granted anything meaningful and can be deleted; seed scripts that write to the store directly must pass real ids and role names.

### Patch Changes

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
- Updated dependencies [b69ea05]
- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/permissions@3.0.0

## 1.0.3

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/permissions@2.0.0

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.2

### Patch Changes

- Add `PRAGMA busy_timeout = 5000` so a write waits for a competing writer's
  lock (up to 5s) instead of throwing `database is locked` immediately. Prevents
  spurious 500s under dev auto-reload (`tsx watch`) or concurrent writers.

## 1.0.1

### Patch Changes

- Fix a runtime crash when consumed from the published package: the bundler
  stripped the `node:` prefix from the `node:sqlite` import, emitting a broken
  `from "sqlite"` that failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`.
  The builtin is now loaded through an opaque specifier the bundler leaves intact.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.30.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementation of the
  `@basaltkit/permissions` `AccessStore` (role assignments and permission grants,
  scoped), on Node's built-in `node:sqlite`, with zero external dependencies.
  Writes are `INSERT OR IGNORE` (grants are sets). `sqliteAccessStore(location)`
  returns the store named to drop straight into `permissionsPlugin`. The
  single-node counterpart to `@basaltkit/permissions-prisma`.
