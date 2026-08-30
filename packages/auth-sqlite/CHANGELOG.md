# @basaltkit/auth-sqlite

## 1.4.0

### Minor Changes

- 104cfb3: Refresh-token reuse detection is now atomic — a compare-and-swap, not a read-then-write.
  
  **Advisory — this changes a store contract.** `Auth.refresh()` reads the record, checks `usedAt`, then calls `markUsed()`. The database stores implemented `markUsed` as an unconditional `UPDATE … WHERE token = ?`, so the check and the write were not one operation: two concurrent refreshes of the same token — the legitimate client and a thief racing it — could both read `usedAt = null` and both succeed. Rotation-reuse detection, the whole point of the family, never fired. Verified live: `Promise.allSettled([auth.refresh(t), auth.refresh(t)])` returned **two** valid token pairs.
  
  `AuthTokenStore.markUsed` and `RefreshTokenStore.markUsed` now return `Promise<boolean | void>`: `true` when *this* call consumed the token, `false` when someone else already had. The shipped stores do a conditional update (`WHERE token = ? AND used_at IS NULL`, `where: { token, usedAt: null }`) and report the row count. `Auth.refresh()` treats `false` as reuse — it revokes the family and throws `AUTH_REFRESH_REUSED`; `consumeToken()` (email verification, password reset) treats it as a spent token and throws `AUTH_TOKEN_INVALID`. The same race now resolves to exactly one winner and one `RefreshReusedError`.
  
  Returning `void` keeps the pre-CAS behaviour, so a **third-party store written against the old contract keeps compiling and working** — without the race protection. If you maintain one, make `markUsed` conditional and return whether it consumed the token.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.3.0

### Minor Changes

- Persist the TOTP `lastUsedStep` (anti-replay) and add the `auth_token_versions` table + `SqliteTokenVersionStore` for access-token revocation.

## 1.2.0

### Minor Changes

- Security: **`SqliteSessionStore` hashes session ids at rest.** It now mints a raw id for the client but stores `sha256(id)` in `auth_sessions`, hashing on the way in for `find`/`delete`, so a dump of the table can't be replayed as a live session (see `@basaltkit/auth` 1.2.0). No schema change; existing sessions are invalidated once on upgrade.

## 1.1.0

### Minor Changes

- Add `SqliteSessionStore.deleteAllForUser(userId)` so a password reset revokes every one of the user's active sessions (see `@basaltkit/auth` 1.1.0). Deletes all `auth_sessions` rows for the user in one statement.

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

## 0.25.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of every
  `@basaltkit/auth` store — users, sessions, refresh tokens, one-time tokens, API
  keys and MFA — built on Node's built-in `node:sqlite`, with zero external
  dependencies. `sqliteAuthStores(location)` returns every store named to drop
  straight into `authPlugin`/`apiKeysPlugin`, so auth state survives process
  restarts. Each store is also exported individually and accepts a shared
  `DatabaseSync`. The first reference "real backend" on the road to 1.0.
