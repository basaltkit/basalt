<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions-prisma

**Prisma-backed** implementations of every
[`@basaltkit/subscriptions`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions)
store — the **subscription** record, **usage** metering, **webhook** idempotency, the
**payment ledger** and **recurring** subscriptions — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient`; the stores only touch the delegates they need
(`subscription`, `usageCounter`, `webhookEvent` for `prismaSubscriptionsStores`; `payment`
and `recurringSubscription` for `prismaPaymentStores`). The production counterpart to
[`@basaltkit/subscriptions-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/subscriptions-sqlite).

```bash
pnpm add @basaltkit/subscriptions-prisma   # peer: @basaltkit/subscriptions ; you already have @prisma/client
```

## 1. Add the models

Copy the models from the bundled reference schema
(`prisma/schema.prisma` in this package) into your `schema.prisma`:

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
  pendingPlan       String?
  pendingPeriod     String?
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

> `pendingPlan` / `pendingPeriod` are **required**, not optional extras. They carry the
> checkout *intent* that `@basaltkit/subscriptions` refuses to promote until the gateway
> confirms payment with a new subscription ref — the guard against plan escalation via an
> abandoned checkout. `PrismaSubscriptionStore.save` always writes both (writing `null`
> clears them), so a schema without the columns fails on every save.

And, if you use the payment ledger / reference-based recurring billing, these two as well —
`amount` is `BigInt` (minor units) to avoid the 32-bit `Int` ceiling:

```prisma
model Payment {
  id         String   @id
  status     String   @default("pending")
  amount     BigInt
  billableId String?
  reference  String?
  raw        String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([status])
  @@map("payments")
}
model RecurringSubscription {
  billableId       String    @id
  plan             String
  amount           BigInt
  interval         String
  status           String
  paidThrough      DateTime?
  pendingPaymentId String?
  customer         String?
  createdAt        DateTime
  updatedAt        DateTime
  @@index([status])
  @@map("recurring_subscriptions")
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
| `PrismaPaymentStore` | `PaymentStore` | `Payment` |
| `PrismaRecurringStore` | `RecurringStore` | `RecurringSubscription` |

Counter rows are seeded with `createMany({ skipDuplicates: true })` rather than an
`upsert`: two concurrent upserts of the same new row both miss and race to `INSERT`,
failing with `P2002` on a real database.

## Payment ledger & recurring billing

```ts
import { PaymentLedger, RecurringReferenceBilling } from '@basaltkit/subscriptions'
import { prismaPaymentStores, prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'

const s = prismaSubscriptionsStores(prisma)
const p = prismaPaymentStores(prisma)

const ledger = new PaymentLedger({ store: p.payments, webhooks: s.webhooks })
const billing = new RecurringReferenceBilling({ gateway, ledger, store: p.recurring })
```

`PrismaPaymentStore.create` is an atomic idempotent insert (`skipDuplicates`), so a
concurrent create neither throws nor clobbers. `setStatus` upserts, and falls back to an
`update` when it loses a create race (`P2002`) — a webhook that beats the local record
still settles.

## API reference

| Export | Signature | Purpose |
| --- | --- | --- |
| `prismaSubscriptionsStores` | `(client: PrismaSubscriptionsClient) => { store, usage, webhooks }` | Named to drop straight into `subscriptionsPlugin`. |
| `prismaPaymentStores` | `(client: PrismaPaymentsClient) => { payments, recurring }` | For `PaymentLedger` / `RecurringReferenceBilling`. |

Both validate up front that the client actually has the delegates they need, and throw an
actionable `Error` naming the model and how to add it — instead of a cryptic
`reading 'create' of undefined` at the first write. A lazy/proxy client (as used by
database-per-tenant) skips the check and is validated at first use instead.

## Multi-tenant?

For **database-per-tenant**, route the stores through the active tenant's client
— see the [Database-per-tenant guide](https://basaltkit-docs.pages.dev/guide/database-per-tenant).

## Typing note

`PrismaSubscriptionsClient` and `PrismaPaymentsClient` type delegate **arguments** as `any`
(returns stay precise) so a real `PrismaClient` is assignable and passes directly —
Prisma's generated method generics can't be reproduced by a hand-written interface.

## Failure modes

This package defines no error classes of its own; domain errors come from
`@basaltkit/subscriptions` (`BILLING_QUOTA_EXCEEDED`, …) and database errors from Prisma.

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `Error` (plain) | — | — | The Prisma client has no `subscription` / `payment` / `recurringSubscription` model. The message names the model and points at `basalt prisma:sync` or the bundled schema. |
| `PrismaClientKnownRequestError` | `P2002` | — | A unique-constraint race. The payment stores catch it and retry as an update; elsewhere it surfaces. |

Symptoms:

- **`Unknown argument 'pendingPlan'` on every save** — the `Subscription` model is missing
  the two pending columns. Add them and migrate.
- **`Unknown argument 'amount'` / a value out of range on payments** — `amount` must be
  `BigInt`, not `Int`; minor units overflow 32 bits quickly.
- **A quota is overshot under load** — the conditional `updateMany` guard only holds when
  every process shares one database. Check you aren't mixing in a memory store.
- **A redelivered webhook is processed twice** — `webhookEvent` must have `id` as the
  primary key, so `createMany({ skipDuplicates: true })` can be the atomic claim.

Guides: [Billing](/guide/billing) · [Payment references](/guide/reference-payments) · [Persistence](/guide/persistence) · [Database per tenant](/guide/database-per-tenant)

## License

MIT
