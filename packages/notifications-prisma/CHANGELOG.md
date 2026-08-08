# @machize/notifications-prisma

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `mach prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @machize/notifications `InAppStore` (in-app inbox), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaInAppStore(prisma)` returns the store named to drop straight into `notificationsPlugin`. The production counterpart to `@machize/notifications-sqlite`.
