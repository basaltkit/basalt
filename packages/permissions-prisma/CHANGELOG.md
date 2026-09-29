# @basaltkit/permissions-prisma

## 2.1.0

### Minor Changes

- b7171e5: Durable `TemporaryGrantStore` and `DelegationStore` (FRAMEWORK-AUDIT FA-H07). Only the in-memory stores existed, so time-boxed grants and delegations vanished on restart and were invisible to other instances.
  
  - `@basaltkit/permissions-prisma`: `PrismaTemporaryGrantStore` and `PrismaDelegationStore` on two new models, `PermTemporaryGrant` (`perm_temporary_grants`) and `PermDelegation` (`perm_delegations`), in the reference `schema.prisma` (`permissions String[]`) and `schema.mysql.prisma` (`permissions Json`, `reason` TEXT, `columnLimits: 'mysql'` preset extended). `prismaAccessStore()` now also returns `temporaryGrants` and `delegations`. The models are optional on `PrismaPermissionsClient` and checked on first use, so an app that does not wire the new stores needs no migration; one that does adds the two models (`basalt prisma:sync`) and migrates.
  - `@basaltkit/permissions-sqlite`: `SqliteTemporaryGrantStore` and `SqliteDelegationStore`; `migrate()` creates `perm_temporary_grants` and `perm_delegations` (`CREATE TABLE IF NOT EXISTS`, so existing databases gain them on the next open). `sqliteAccessStore()` now also returns `temporaryGrants` and `delegations`.
  
  Both filter `expires_at > now`, user and scope in the query (the Gate re-verifies each row regardless), validate what they persist (`TypeError` on an empty id/user/scope, a non-string permission, a non-finite or out-of-range deadline), replace on a repeated id like the in-memory stores, and add `pruneExpired(now?)` to delete inert rows. Wire them with:
  
  ```ts
  const p = prismaAccessStore(prisma) // or sqliteAccessStore('./data/permissions.db')
  permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
  ```

### Patch Changes

- Updated dependencies [b7171e5]
- Updated dependencies [fdb3f31]
  - @basaltkit/permissions@4.0.0

## 2.0.0

### Major Changes

- b69ea05: Framework audit residuals: empty permission segments and malformed store writes.
  
  - **An empty segment never matches.** `permissionMatches('projects:*', 'projects:')` and `permissionMatches('', '')` used to return `true` (the wildcard matched the empty action; equal strings short-circuited). A permission with an empty `:` segment — `''`, `'projects:'`, `':read'`, `'a::b'` — now matches nothing, not even itself, and `'*'` does not cover it. New `hasEmptySegment(permission)` (also on the browser-safe `@basaltkit/permissions/match` entry).
  - **The Gate refuses such permissions.** `can()`, `grantToRole`/`grantToUser`/`grantTemporarily`/`delegate` and `roleCatalog` throw a `TypeError` for a permission with an empty segment, as they already did for whitespace. `MemoryAccessStore.assignRole`/`grantToRole` also refuse an empty or non-string role name.
  - **`SqliteAccessStore` / `PrismaAccessStore` validate direct writes.** `assignRole`, `removeRole`, `grantToRole` and `grantToUser` throw a `TypeError` for an empty or non-string user id, role name or scope, or a permission list that is not an array of non-empty strings — before anything is written. `''`, `null` and `undefined` used to be persisted and shared one "nobody" key.
  
  **Why major:** input that used to be accepted now throws. Migration: find stored grants with an empty segment (`SELECT … WHERE permission LIKE '%:' OR permission LIKE ':%' OR permission LIKE '%::%' OR permission = ''`) — they never granted anything meaningful and can be deleted; seed scripts that write to the store directly must pass real ids and role names.

### Minor Changes

- b69ea05: MySQL column limits for `auth-prisma`, `permissions-prisma` and `teams-prisma` (framework audit FA-070, completing the set).
  
  The same guard the other `*-prisma` packages gained: on MySQL a bare `String`
  is `VARCHAR(191)`, and a server outside strict mode truncates a longer value
  silently — a cut password hash never verifies, a cut sealed TOTP secret no
  longer opens, a cut invitation email no longer names its recipient, and two
  long permission names cut to one prefix collapse into a single grant.
  
  - Each package ships **`schema.mysql.prisma`** (exported as
    `@basaltkit/<pkg>/schema.mysql.prisma`). `auth-prisma`: `AuthUser.email`
    `VARCHAR(254)`; `passwordHash`, the API key `name`, the MFA `secret`, the
    account link `subject`/`email` and the passkey
    `credentialId`/`publicKey`/`transports`/`deviceName` `TEXT`; `scopes` and
    `recoveryCodes` `Json` (MySQL has no scalar lists — the stores now read
    either form). `teams-prisma`: invitation `email` `VARCHAR(254)`.
    `permissions-prisma`: every column is part of a composite primary key and
    stays `VARCHAR(191)`. Keys stay indexable within InnoDB's 3 072-byte limit.
  - Every factory and store class takes an optional **`columnLimits`**
    (`'mysql'` — `authMysqlColumnLimits`, `permissionsMysqlColumnLimits`,
    `teamsMysqlColumnLimits` — or your own). With it set, a value longer than
    its column is refused with `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`,
    422) before anything is written; `grantToRole`/`grantToUser` check the whole
    batch first.
  - `basalt prisma:sync` now finds a MySQL variant for every package; its
    warning for an (older) package without one suggests upgrading it.
  
  Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
  calls keep their signatures (the option is a new trailing parameter).

### Patch Changes

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

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `basalt prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.30.0

### Minor Changes

- Initial release. Prisma-backed implementation of the `@basaltkit/permissions`
  `AccessStore` for production databases (PostgreSQL/MySQL). Writes are
  `createMany({ skipDuplicates: true })` (grants are sets).
  `prismaAccessStore(prisma)` returns the store named to drop straight into
  `permissionsPlugin`. Ships a reference `schema.prisma`. The production
  counterpart to `@basaltkit/permissions-sqlite`.
