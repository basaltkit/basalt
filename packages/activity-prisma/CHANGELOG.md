# @machize/activity-prisma

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @machize/activity `ActivityStore` (activity feed), on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaActivityStore(prisma)` returns the store named to drop straight into `activityPlugin`. The production counterpart to `@machize/activity-sqlite`.
