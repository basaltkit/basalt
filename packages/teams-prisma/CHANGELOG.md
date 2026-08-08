# @machize/teams-prisma

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.27.0

### Minor Changes

- Initial release. Prisma-backed implementations of the `@machize/teams` stores —
  memberships and invitations — for production databases (PostgreSQL/MySQL).
  Bring your generated `PrismaClient`; `prismaTeamsStores(prisma)` returns both
  stores named to drop straight into `teamsPlugin`. Ships a reference
  `schema.prisma`. The production counterpart to `@machize/teams-sqlite`.
