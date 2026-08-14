# @basaltkit/auth-prisma

## 1.1.0

### Minor Changes

- Add `PrismaSessionStore.deleteAllForUser(userId)` so a password reset revokes every one of the user's active sessions (see `@basaltkit/auth` 1.1.0). Uses `authSession.deleteMany({ where: { userId } })`.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.4

### Patch Changes

- Fail fast with an actionable error when the Prisma client is missing the models this package needs (previously a cryptic "reading create of undefined") — points to `basalt prisma:sync` or the reference schema. Lazy/proxy clients (database-per-tenant) are tolerated.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.26.0

### Minor Changes

- Initial release. Prisma-backed implementations of every `@basaltkit/auth` store
  — users, sessions, refresh tokens, one-time tokens, API keys and MFA — for
  production databases (PostgreSQL/MySQL). Bring your generated `PrismaClient`;
  `prismaAuthStores(prisma)` returns every store named to drop straight into
  `authPlugin`/`apiKeysPlugin`. Ships a reference `schema.prisma`. The production
  counterpart to `@basaltkit/auth-sqlite` — same contracts, different backend.
