# @basaltkit/auth-sqlite

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
