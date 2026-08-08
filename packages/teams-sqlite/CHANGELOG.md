# @machize/teams-sqlite

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
