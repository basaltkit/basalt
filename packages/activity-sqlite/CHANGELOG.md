# @machize/activity-sqlite

## 0.29.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementation of the @machize/activity `ActivityStore` (activity feed), on Node's built-in `node:sqlite`, with zero external dependencies. `sqliteActivityStore(location)` returns the store named to drop straight into `activityPlugin`. The single-node counterpart to `@machize/activity-prisma`.
