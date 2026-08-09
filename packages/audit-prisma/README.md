# @basaltkit/audit-prisma

**Prisma-backed** implementation of the
[`@basaltkit/audit`](https://github.com/Zebedeu/basalt/tree/main/packages/audit)
`AuditStore` — the append-only audit trail — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `AuditEntry` model; the store only
touches that delegate. The production counterpart to
[`@basaltkit/audit-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/audit-sqlite).

```bash
pnpm add @basaltkit/audit-prisma   # peer: @basaltkit/audit ; you already have @prisma/client
```

## 1. Add the model

Copy the model from the bundled reference schema
(`@basaltkit/audit-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model AuditEntry {
  id        String   @id
  source    String
  event     String
  payload   String?
  actorId   String?
  tenantId  String?
  requestId String?
  at        DateTime
  @@index([tenantId, at])
  @@map("audit_entries")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the store

```ts
import { auditPlugin } from '@basaltkit/audit'
import { prismaAuditStore } from '@basaltkit/audit-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const a = prismaAuditStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [auditPlugin({ store: a.store })] })
```

## Notes

- **Append-only by contract** — no update or delete.
- Queries return **newest-first** with the same filters as the in-memory store
  (`tenantId`, `actorId`, `since`, and the event wildcard `auth:**`). The wildcard
  and `limit` are applied after the exact filters, so `limit` counts only
  pattern-matched rows.
- The `payload` is stored as JSON text and round-trips unchanged.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).
- `PrismaAuditClient` types delegate **arguments** as `any` (returns stay precise)
  so a real `PrismaClient` is assignable and passes directly.

## License

MIT
