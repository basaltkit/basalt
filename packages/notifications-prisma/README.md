<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/notifications-prisma

**Prisma-backed** implementation of the
[`@basaltkit/notifications`](https://github.com/basaltkit/basalt/tree/main/packages/notifications)
`InAppStore` — the in-app notification inbox — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `InAppNotification` model; the
store only touches that delegate. The production counterpart to
[`@basaltkit/notifications-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/notifications-sqlite).

```bash
pnpm add @basaltkit/notifications-prisma   # peer: @basaltkit/notifications ; you already have @prisma/client
```

## 1. Add the model

Copy the model from the bundled reference schema
(`@basaltkit/notifications-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model InAppNotification {
  id           String    @id
  recipientId  String
  notification String
  title        String
  body         String?
  data         String?
  readAt       DateTime?
  at           DateTime
  groupKey     String?   // optional: only needed for InAppMessage.groupKey
  count        Int?
  @@index([recipientId, at])
  @@index([recipientId, groupKey])
  @@map("in_app_notifications")
}

// optional: durable preferences — prismaPreferenceStore(prisma)
model NotificationPreference {
  userId       String
  notification String
  channel      String
  enabled      Boolean
  @@id([userId, notification, channel])
  @@map("notification_preferences")
}
```

Then `prisma migrate dev` and `prisma generate`. The `groupKey`/`count` columns
are written only by grouped notifications, so a schema without them keeps
working for everything else; add them before using `groupKey`.

## 2. Wire the store

```ts
import { notificationsPlugin } from '@basaltkit/notifications'
import { prismaInAppStore, prismaPreferenceStore } from '@basaltkit/notifications-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const n = prismaInAppStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [notificationsPlugin({ inApp: n.store, preferences: prismaPreferenceStore(prisma), mailer })] })
```

`PrismaInAppStore` implements the optional `markAllRead` (one `updateMany`),
`prune` (retention, `deleteMany`) and `upsertGroup` (an atomic `count`
increment on the unread row of the group, else a create).

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. A cut title or body is shown cut, and a cut `data` is no longer valid JSON.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/notifications-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaInAppStore(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `notificationsMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ InAppNotification: { ...notificationsMysqlColumnLimits.InAppNotification, notification: 500 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Notes

- `list()` returns **newest-first**, with `unreadOnly` and `limit`;
  `unreadCount()` counts unread.
- `markRead()` marks only an existing, still-unread notification (a conditional
  `updateMany` on `readAt: null`), so it's idempotent and reports whether it
  changed anything.
- `data` is stored as JSON text and round-trips unchanged.
- For **database-per-tenant**, route the store through the active tenant's client
  — see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).
- `PrismaNotificationsClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## License

MIT
