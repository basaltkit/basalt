# @basaltkit/activity-prisma

**Prisma-backed** implementation of the
[`@basaltkit/activity`](https://github.com/Zebedeu/basalt/tree/main/packages/activity)
`ActivityStore` — the activity feed — for production databases (PostgreSQL,
MySQL, …).

You bring a generated `PrismaClient` with the `ActivityRecord` model; the store
only touches that delegate. The production counterpart to
[`@basaltkit/activity-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/activity-sqlite).

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
