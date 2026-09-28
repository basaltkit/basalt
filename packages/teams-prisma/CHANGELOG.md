# @basaltkit/teams-prisma

## 1.1.0

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

- e53db52: `findPending(tenantId, email)` now matches the canonical address (trimmed, lower-cased) on both sides, so a pending invitation stored as `Bob@x.test` is found for `bob@x.test` — including legacy mixed-case rows (FA-045). The comparison runs in JS: SQLite's `lower()` only folds ASCII, and Prisma's `mode: 'insensitive'` is PostgreSQL/MongoDB-only. No schema or data migration.
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
  - @basaltkit/teams@4.0.0

## 1.0.4

### Patch Changes

- fb85c40: Security hardening (B03):
  
  - `POST /team/invites/accept` now requires `ctx().user.emailVerified === true` (`403 TEAM_EMAIL_NOT_VERIFIED`) and refuses callers without an email. Previously, anyone who registered the invitee's address, or an identity with no email, could redeem a leaked link. Opt out explicitly with `teamRoutes({ requireVerifiedEmail: false })`.
  - `removeMember` accepts `{ actingUserId }`, and `DELETE /team/members/:userId` passes it. An actor can remove only themselves or a member who does not outrank them, so an admin can no longer remove an owner.
  - An acting user can no longer grant roles that are missing from `roleRank` (`403 TEAM_ROLE_NOT_GRANTABLE`) unless they are listed in the new `grantableRoles` option. `rankOf` ignores prototype keys.
  - Invitation acceptance is a compare-and-set, so one token enrolls at most one account. `InvitationStore.markAccepted` may now resolve `boolean`, and the memory, SQLite and Prisma stores implement it atomically. The last-owner rule is re-checked after each write and rolled back on a lost race.
  - The `tenantMembershipPlugin` decision cache no longer re-caches a decision that was invalidated while its lookup was in flight.
  - Team routes fail closed when there is no acting user instead of falling back to the service's trusted mode.
- Updated dependencies [fb85c40]
  - @basaltkit/teams@3.0.0

## 1.0.3

### Patch Changes

- Updated dependencies [d5ca076]
  - @basaltkit/teams@2.0.0

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

## 0.27.0

### Minor Changes

- Initial release. Prisma-backed implementations of the `@basaltkit/teams` stores —
  memberships and invitations — for production databases (PostgreSQL/MySQL).
  Bring your generated `PrismaClient`; `prismaTeamsStores(prisma)` returns both
  stores named to drop straight into `teamsPlugin`. Ships a reference
  `schema.prisma`. The production counterpart to `@basaltkit/teams-sqlite`.
