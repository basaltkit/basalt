# @basaltkit/activity-sqlite

Durable, **SQLite-backed** implementation of the
[`@basaltkit/activity`](https://github.com/basaltkit/basalt/tree/main/packages/activity)
`ActivityStore` — the activity feed — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

Swap it in for the in-memory store and the feed survives a restart — no ORM, no
migration tool, no service. The single-node reference backend; the production
(Postgres/MySQL) counterpart is
[`@basaltkit/activity-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/activity-prisma).

```bash
pnpm add @basaltkit/activity-sqlite   # peer: @basaltkit/activity
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

```ts
import { activityPlugin } from '@basaltkit/activity'
import { sqliteActivityStore } from '@basaltkit/activity-sqlite'

const a = sqliteActivityStore('./data/activity.db')   // ':memory:' by default

const app = await createApp({
  plugins: [activityPlugin({ store: a.store })],
}).boot()
```

`SqliteActivityStore` is also exported and takes a `DatabaseSync`, so it can
share a handle with the other `*-sqlite` stores. `openActivityDatabase()` and
`migrate()` are exported too.

## Notes

- One `activity_records` table, indexed by tenant and subject.
- Queries return **newest-first** with the same exact filters as the in-memory
  store (`log`, `subjectType`, `subjectId`, `causerId`, `tenantId`) and `limit`.
- `properties` are stored as JSON text and round-trip unchanged.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contract.

## License

MIT
