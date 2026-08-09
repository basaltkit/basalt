# @basaltkit/subscriptions-prisma

**Prisma-backed** implementations of the three
[`@basaltkit/subscriptions`](https://github.com/Zebedeu/basalt/tree/main/packages/subscriptions)
stores — the **subscription** record, **usage** metering and **webhook**
idempotency — for production databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `Subscription`, `UsageCounter` and
`WebhookEvent` models; the stores only touch those delegates. The production
counterpart to
[`@basaltkit/subscriptions-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/subscriptions-sqlite).

```bash
pnpm add @basaltkit/subscriptions-prisma   # peer: @basaltkit/subscriptions ; you already have @prisma/client
```

## 1. Add the models

Copy the models from the bundled reference schema
(`@basaltkit/subscriptions-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model Subscription {
  billableId        String    @id
  plan              String
  period            String
  status            String
  trialEndsAt       DateTime?
  cancelAtPeriodEnd Boolean?
  canceledAt        DateTime?
  gatewayRef        String?
  @@map("subscriptions")
}
model UsageCounter {
  billableId String
  feature    String
  periodKey  String
  value      Int    @default(0)
  @@id([billableId, feature, periodKey])
  @@map("usage_counters")
}
model WebhookEvent {
  id     String   @id
  seenAt DateTime @default(now())
  @@map("webhook_events")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the stores

`prismaSubscriptionsStores(prisma)` returns all three stores named to drop
straight into `subscriptionsPlugin` — pass your client directly, no cast:

```ts
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaSubscriptionsStores(prisma)

createApp({
  plugins: [subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })],
})
```

## Atomic usage metering

The metered `consume()` uses a conditional `updateMany` (`value <= limit -
amount`) that the database's row lock serializes, so a plan quota is **never
overshot under concurrency**. Webhook idempotency is an atomic
`createMany({ skipDuplicates: true })` claim, so a redelivered event is processed
once across restarts and instances.

| Export | Contract | Model |
| --- | --- | --- |
| `PrismaSubscriptionStore` | `SubscriptionStore` | `Subscription` |
| `PrismaUsageStore` | `UsageStore` (atomic `consume`) | `UsageCounter` |
| `PrismaWebhookStore` | `WebhookStore` | `WebhookEvent` |

## Multi-tenant?

For **database-per-tenant**, route the stores through the active tenant's client
— see the [Database-per-tenant guide](https://basalt-docs.pages.dev/guide/database-per-tenant).

## Typing note

`PrismaSubscriptionsClient` types delegate **arguments** as `any` (returns stay
precise) so a real `PrismaClient` is assignable and passes directly — Prisma's
generated method generics can't be reproduced by a hand-written interface.

## License

MIT
