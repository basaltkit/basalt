<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/audit-sqlite

Durable, **SQLite-backed** implementation of the
[`@basaltkit/audit`](https://github.com/basaltkit/basalt/tree/main/packages/audit)
`AuditStore` — the append-only audit trail — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

Swap it in for the in-memory store and the trail survives a restart — no ORM, no
migration tool, no service. The single-node reference backend; the production
(Postgres/MySQL) counterpart is
[`@basaltkit/audit-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/audit-prisma).

```bash
pnpm add @basaltkit/audit-sqlite   # peer: @basaltkit/audit
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

```ts
import { auditPlugin } from '@basaltkit/audit'
import { sqliteAuditStore } from '@basaltkit/audit-sqlite'

const a = sqliteAuditStore('./data/audit.db')   // ':memory:' by default

const app = await createApp({
  plugins: [auditPlugin({ store: a.store })],
}).boot()
```

`SqliteAuditStore` is also exported and takes a `DatabaseSync`, so it can share a
handle with the other `*-sqlite` stores. `openAuditDatabase()` and `migrate()`
are exported too.

## Notes

- **Append-only by contract** — one `audit_entries` table, no update or delete.
- Queries return **newest-first** with the same filters as the in-memory store:
  `tenantId`, `actorId`, `since`, and the **event wildcard** (`auth:**`).
  `limit` always counts only pattern-matched rows.
- The `payload` is stored as JSON text and round-trips unchanged.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contract.
- **Query pushdown.** Every exact filter — tenant, actor, `since`, and an event name with **no** wildcard — plus the `limit` go into the database (`take` / `LIMIT`). Only a wildcard pattern still needs matching in code, and then rows are read in bounded 500-row pages that stop as soon as the limit is satisfied, so a `limit: 50` query never materialises the whole trail. A pattern containing `.` is deliberately not pushed down: `patternMatches` treats `.` and `:` as interchangeable separators, so an equality would miss `a:b` for `a.b`.

## License

MIT
