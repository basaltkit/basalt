<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/audit-prisma

**Prisma-backed** implementation of the
[`@basaltkit/audit`](https://github.com/basaltkit/basalt/tree/main/packages/audit)
`AuditStore` — the append-only audit trail — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `AuditEntry` model; the store only
touches that delegate. The production counterpart to
[`@basaltkit/audit-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/audit-sqlite).

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
  ip        String?   // requestContext (PII)
  userAgent String?   // requestContext
  chain     String?   // hash chain: 't:<tenantId>' or '@system'
  seq       Int?
  prevHash  String?
  hash      String?
  @@index([tenantId, at])
  @@unique([chain, seq])
  @@map("audit_entries")
}
```

Then `prisma migrate dev` and `prisma generate`.

### Upgrading from 1.1

1.2 adds six nullable columns and a unique index for the hash chain and the
request context. They are only written when you enable
`auditPlugin({ integrity: 'hash-chain' })` or `requestContext` — an app that
upgrades without enabling them keeps working on the old schema. Before enabling
them, add the columns to the model above and migrate; on PostgreSQL the
migration is:

```sql
ALTER TABLE "audit_entries"
  ADD COLUMN "ip" TEXT,
  ADD COLUMN "userAgent" TEXT,
  ADD COLUMN "chain" TEXT,
  ADD COLUMN "seq" INTEGER,
  ADD COLUMN "prevHash" TEXT,
  ADD COLUMN "hash" TEXT;
CREATE UNIQUE INDEX "audit_entries_chain_seq_key" ON "audit_entries"("chain", "seq");
```

Existing rows keep NULLs: `audit.verify()` reports them as *unchained*, not
broken. With schema-per-tenant, migrate every tenant schema (`basalt tenant:migrate`).

### Harden the table

The `@@unique([chain, seq])` constraint is what stops two replicas from forking
a chain: the losing insert fails with `P2002`, which the store maps to
`AuditChainConflictError`, and `Audit` retries on the new head. Also make the
database enforce append-only, so the application role cannot rewrite history
even if it is compromised:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_entries" FROM app_role;
GRANT SELECT, INSERT ON "audit_entries" TO app_role;
```

Run migrations with a separate owner role. See the
[`@basaltkit/audit` README](https://github.com/basaltkit/basalt/tree/main/packages/audit#verifiable-trail-hash-chain)
for keyed chains (HMAC), anchoring the head, and `basalt audit:verify`.

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

- **Append-only by contract** — no update or delete (enforce it in the database too — see above).
- `PrismaAuditClient` also accepts an optional `count` delegate (every generated client has it), used by `verify()` to count unchained legacy rows.
- Queries return **newest-first** with the same filters as the in-memory store
  (`tenantId`, `actorId`, `since`, and the event wildcard `auth:**`). `limit`
  always counts only pattern-matched rows.
- The `payload` is stored as JSON text and round-trips unchanged.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).
- `PrismaAuditClient` types delegate **arguments** as `any` (returns stay precise)
  so a real `PrismaClient` is assignable and passes directly.
- **Query pushdown.** Every exact filter — tenant, actor, `since`, and an event name with **no** wildcard — plus the `limit` go into the database (`take` / `LIMIT`). Only a wildcard pattern still needs matching in code, and then rows are read in bounded 500-row pages that stop as soon as the limit is satisfied, so a `limit: 50` query never materialises the whole trail. A pattern containing `.` is deliberately not pushed down: `patternMatches` treats `.` and `:` as interchangeable separators, so an equality would miss `a:b` for `a.b`.

## License

MIT
