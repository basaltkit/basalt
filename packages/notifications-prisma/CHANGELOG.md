# @machize/notifications-prisma

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @machize/notifications `InAppStore` (in-app inbox), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaInAppStore(prisma)` returns the store named to drop straight into `notificationsPlugin`. The production counterpart to `@machize/notifications-sqlite`.
