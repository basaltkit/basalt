# @machize/teams-prisma

## 0.27.0

### Minor Changes

- Initial release. Prisma-backed implementations of the `@machize/teams` stores —
  memberships and invitations — for production databases (PostgreSQL/MySQL).
  Bring your generated `PrismaClient`; `prismaTeamsStores(prisma)` returns both
  stores named to drop straight into `teamsPlugin`. Ships a reference
  `schema.prisma`. The production counterpart to `@machize/teams-sqlite`.
