# @machize/notifications-sqlite

## 0.29.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementation of the @machize/notifications `InAppStore` (in-app inbox), on Node's built-in `node:sqlite`, with zero external dependencies. `sqliteInAppStore(location)` returns the store named to drop straight into `notificationsPlugin`. The single-node counterpart to `@machize/notifications-prisma`.
