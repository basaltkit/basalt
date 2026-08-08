# @machize/auth-prisma

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.26.0

### Minor Changes

- Initial release. Prisma-backed implementations of every `@machize/auth` store
  — users, sessions, refresh tokens, one-time tokens, API keys and MFA — for
  production databases (PostgreSQL/MySQL). Bring your generated `PrismaClient`;
  `prismaAuthStores(prisma)` returns every store named to drop straight into
  `authPlugin`/`apiKeysPlugin`. Ships a reference `schema.prisma`. The production
  counterpart to `@machize/auth-sqlite` — same contracts, different backend.
