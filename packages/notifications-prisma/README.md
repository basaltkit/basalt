# @basaltkit/notifications-prisma

**Prisma-backed** implementation of the
[`@basaltkit/notifications`](https://github.com/Zebedeu/basalt/tree/main/packages/notifications)
`InAppStore` — the in-app notification inbox — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `InAppNotification` model; the
store only touches that delegate. The production counterpart to
[`@basaltkit/notifications-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/notifications-sqlite).

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
  @@index([recipientId, at])
  @@map("in_app_notifications")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the store

```ts
import { notificationsPlugin } from '@basaltkit/notifications'
import { prismaInAppStore } from '@basaltkit/notifications-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const n = prismaInAppStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [notificationsPlugin({ inApp: n.store, mailer })] })
```

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
