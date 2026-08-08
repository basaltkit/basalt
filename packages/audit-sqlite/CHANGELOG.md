# @machize/audit-sqlite

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.29.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementation of the @machize/audit `AuditStore` (append-only, with the event wildcard), on Node's built-in `node:sqlite`, with zero external dependencies. `sqliteAuditStore(location)` returns the store named to drop straight into `auditPlugin`. The single-node counterpart to `@machize/audit-prisma`.
