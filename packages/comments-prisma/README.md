# @machize/comments-prisma

**Prisma-backed** implementation of the
[`@machize/comments`](https://github.com/Zebedeu/machize/tree/main/packages/comments)
`CommentStore` — per-resource threads with @mentions and resolve/reopen — for
production databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `Comment` model; the store only
touches that delegate. The production counterpart to
[`@machize/comments-sqlite`](https://github.com/Zebedeu/machize/tree/main/packages/comments-sqlite).

```bash
pnpm add @machize/comments-prisma   # peer: @machize/comments ; you already have @prisma/client
```

## 1. Add the model

Copy the model from the bundled reference schema
(`@machize/comments-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model Comment {
  tenantId     String
  id           String
  resourceType String
  resourceId   String
  parentId     String?
  authorId     String
  body         String
  mentions     String[]
  resolvedAt   DateTime?
  resolvedBy   String?
  editedAt     DateTime?
  createdAt    DateTime
  @@id([tenantId, id])
  @@index([tenantId, resourceType, resourceId])
  @@map("comments")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the store

```ts
import { commentsPlugin } from '@machize/comments'
import { prismaCommentsStore } from '@machize/comments-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const c = prismaCommentsStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [commentsPlugin({ store: c.store })] })
```

## Notes

- **Resolve/reopen** is faithful: a patch key present with `undefined` clears the
  column (reopen), an absent key is left untouched.
- Timestamps are stored as `DateTime` and converted to/from the epoch-ms numbers
  the `@machize/comments` contract uses.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://machize-docs.pages.dev/guide/database-per-tenant).
- `PrismaCommentsClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## License

MIT
