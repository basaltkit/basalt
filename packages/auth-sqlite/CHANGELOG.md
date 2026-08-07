# @machize/auth-sqlite

## 0.25.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of every
  `@machize/auth` store — users, sessions, refresh tokens, one-time tokens, API
  keys and MFA — built on Node's built-in `node:sqlite`, with zero external
  dependencies. `sqliteAuthStores(location)` returns every store named to drop
  straight into `authPlugin`/`apiKeysPlugin`, so auth state survives process
  restarts. Each store is also exported individually and accepts a shared
  `DatabaseSync`. The first reference "real backend" on the road to 1.0.
