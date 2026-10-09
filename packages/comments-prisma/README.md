<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/comments-prisma

**Prisma-backed** implementation of the
[`@basaltkit/comments`](https://github.com/basaltkit/basalt/tree/main/packages/comments)
`CommentStore` — per-resource threads with @mentions and resolve/reopen — for
production databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `Comment` model; the store only
touches that delegate. The production counterpart to
[`@basaltkit/comments-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/comments-sqlite).

```bash
pnpm add @basaltkit/comments-prisma   # peer: @basaltkit/comments ; you already have @prisma/client
```

## 1. Add the model

Copy the model from the bundled reference schema
(`@basaltkit/comments-prisma/schema.prisma`) into your `schema.prisma`:

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
  anchor       String?   // optional features: anchor, deletion: 'soft'
  deletedAt    DateTime?
  deletedBy    String?
  deleteReason String?
  @@id([tenantId, id])
  @@index([tenantId, resourceType, resourceId])
  @@map("comments")
}

// optional: only with commentsPlugin({ revisions: true })
model CommentRevision {
  tenantId  String
  id        String
  commentId String
  body      String
  at        DateTime
  by        String?
  @@id([tenantId, id])
  @@index([tenantId, commentId, at])
  @@map("comment_revisions")
}
```

Then `prisma migrate dev` and `prisma generate`. The optional columns are
written only when the feature that needs them is used, so an existing schema
keeps working until you pass an `anchor`, turn on `deletion: 'soft'` or
`revisions: true`.

## 2. Wire the store

```ts
import { commentsPlugin } from '@basaltkit/comments'
import { prismaCommentsStore } from '@basaltkit/comments-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const c = prismaCommentsStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [commentsPlugin({ store: c.store })] })
```

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. A long comment is saved cut short while the author is told it was saved. MySQL also has no scalar lists, so the MySQL variant stores `mentions` as `Json` — the store reads and writes the same array either way. `update()` (an edited body) is checked too.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/comments-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaCommentsStore(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `commentsMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ Comment: { ...commentsMysqlColumnLimits.Comment, resourceType: 500 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Notes

- **Resolve/reopen** is faithful: a patch key present with `undefined` clears the
  column (reopen), an absent key is left untouched.
- Timestamps are stored as `DateTime` and converted to/from the epoch-ms numbers
  the `@basaltkit/comments` contract uses.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).
- `PrismaCommentsClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## License

MIT
