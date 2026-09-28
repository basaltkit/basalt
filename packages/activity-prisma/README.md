<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/activity-prisma

**Prisma-backed** implementation of the
[`@basaltkit/activity`](https://github.com/basaltkit/basalt/tree/main/packages/activity)
`ActivityStore` — the activity feed — for production databases (PostgreSQL,
MySQL, …).

You bring a generated `PrismaClient` with the `ActivityRecord` model; the store
only touches that delegate. The production counterpart to
[`@basaltkit/activity-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/activity-sqlite).

```bash
pnpm add @basaltkit/activity-prisma   # peer: @basaltkit/activity ; you already have @prisma/client
```

## 1. Add the model

Copy the model from the bundled reference schema
(`@basaltkit/activity-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model ActivityRecord {
  id          String   @id
  log         String
  description String
  subjectType String?
  subjectId   String?
  causerId    String?
  tenantId    String?
  properties  String?
  at          DateTime
  @@index([tenantId, at])
  @@index([subjectType, subjectId])
  @@map("activity_records")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the store

```ts
import { activityPlugin } from '@basaltkit/activity'
import { prismaActivityStore } from '@basaltkit/activity-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const a = prismaActivityStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [activityPlugin({ store: a.store })] })
```

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. A cut `properties` is no longer valid JSON, and the feed stops reading back.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/activity-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaActivityStore(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `activityMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ ActivityRecord: { ...activityMysqlColumnLimits.ActivityRecord, log: 500 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Notes

- Queries return **newest-first** with the same exact filters as the in-memory
  store (`log`, `subjectType`, `subjectId`, `causerId`, `tenantId`) and `limit`.
- `properties` are stored as JSON text and round-trip unchanged.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).
- `PrismaActivityClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## License

MIT
