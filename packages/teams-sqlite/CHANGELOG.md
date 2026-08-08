# @machize/teams-sqlite

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

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.27.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of the `@machize/teams`
  stores — memberships and invitations — built on Node's built-in `node:sqlite`,
  with zero external dependencies. `sqliteTeamsStores(location)` returns both
  stores named to drop straight into `teamsPlugin`, so team rosters and pending
  invitations survive process restarts. The single-node counterpart to
  `@machize/teams-prisma`.
