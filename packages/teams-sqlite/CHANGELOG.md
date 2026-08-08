# @machize/teams-sqlite

## 0.27.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of the `@machize/teams`
  stores — memberships and invitations — built on Node's built-in `node:sqlite`,
  with zero external dependencies. `sqliteTeamsStores(location)` returns both
  stores named to drop straight into `teamsPlugin`, so team rosters and pending
  invitations survive process restarts. The single-node counterpart to
  `@machize/teams-prisma`.
