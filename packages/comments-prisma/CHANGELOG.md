# @machize/comments-prisma

## 0.29.0

### Minor Changes

- Initial release. Prisma-backed implementation of the @machize/comments `CommentStore`, on a Prisma client (PostgreSQL/MySQL); ships a reference `schema.prisma`. `prismaCommentsStore(prisma)` returns the store named to drop straight into `commentsPlugin`. The production counterpart to `@machize/comments-sqlite`.
