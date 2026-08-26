<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/notifications-sqlite

Durable, **SQLite-backed** implementation of the
[`@basaltkit/notifications`](https://github.com/basaltkit/basalt/tree/main/packages/notifications)
`InAppStore` — the in-app notification inbox — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

Swap it in for the in-memory store and the inbox survives a restart — no ORM, no
migration tool, no service. The single-node reference backend; the production
(Postgres/MySQL) counterpart is
[`@basaltkit/notifications-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/notifications-prisma).

```bash
pnpm add @basaltkit/notifications-sqlite   # peer: @basaltkit/notifications
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

`@basaltkit/notifications` takes the in-app store as the `inApp` channel option:

```ts
import { notificationsPlugin } from '@basaltkit/notifications'
import { sqliteInAppStore } from '@basaltkit/notifications-sqlite'

const n = sqliteInAppStore('./data/notifications.db')   // ':memory:' by default

const app = await createApp({
  plugins: [notificationsPlugin({ inApp: n.store, mailer })],
}).boot()
```

`SqliteInAppStore` is also exported and takes a `DatabaseSync`, so it can share a
handle with the other `*-sqlite` stores. `openNotificationsDatabase()` and
`migrate()` are exported too.

## Notes

- One `in_app_notifications` table, indexed by recipient.
- `list()` returns **newest-first**, with `unreadOnly` and `limit`, matching the
  in-memory store; `unreadCount()` counts unread.
- `markRead()` marks only an existing, still-unread notification (a
  `WHERE … read_at IS NULL` guard), so it's idempotent and reports whether it
  actually changed anything.
- `data` is stored as JSON text and round-trips unchanged.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contract.

## License

MIT
