# @machize/auth-prisma

## 0.26.0

### Minor Changes

- Initial release. Prisma-backed implementations of every `@machize/auth` store
  — users, sessions, refresh tokens, one-time tokens, API keys and MFA — for
  production databases (PostgreSQL/MySQL). Bring your generated `PrismaClient`;
  `prismaAuthStores(prisma)` returns every store named to drop straight into
  `authPlugin`/`apiKeysPlugin`. Ships a reference `schema.prisma`. The production
  counterpart to `@machize/auth-sqlite` — same contracts, different backend.
