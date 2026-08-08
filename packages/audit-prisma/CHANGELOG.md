# @machize/audit-prisma

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @machize/audit `AuditStore` (append-only, with the event wildcard), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaAuditStore(prisma)` returns the store named to drop straight into `auditPlugin`. The production counterpart to `@machize/audit-sqlite`.
