# @machize/permissions-prisma

## 0.30.0

### Minor Changes

- Initial release. Prisma-backed implementation of the `@machize/permissions`
  `AccessStore` for production databases (PostgreSQL/MySQL). Writes are
  `createMany({ skipDuplicates: true })` (grants are sets).
  `prismaAccessStore(prisma)` returns the store named to drop straight into
  `permissionsPlugin`. Ships a reference `schema.prisma`. The production
  counterpart to `@machize/permissions-sqlite`.
