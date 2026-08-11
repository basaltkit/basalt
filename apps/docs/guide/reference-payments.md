# Reference & mobile-money payments

[[toc]]

Basalt has **two** billing models. Cards with a self-service portal and
card-on-file recurring charges live in [Subscriptions](/guide/billing) (the
`BillingGateway`, e.g. Stripe). This guide covers the **other** model —
**reference and mobile-money payments**, used across Angola and much of Africa,
where there is no card-on-file:

- **Reference** — the customer pays a numeric **Reference** at an ATM, in
  Multicaixa Express, or a bank app, quoting your account's fixed **Entity**.
- **Push** — a prompt is pushed to the customer's phone (Multicaixa Express,
  Unitel Money…), which they approve.
- **Redirect** — a hosted card page.

All three sit behind one contract — `PaymentGateway` — so your checkout and
webhook code never changes when you switch or add a provider. On top of it,
Basalt gives you an **idempotent ledger**, **lifecycle hooks**, **durable
stores** (Prisma / SQLite), a **Redis** dedupe hot-path, and **recurring
billing** modelled as one reference per period.

::: tip Packages
`@basaltkit/subscriptions` (contract + ledger + recurring + money helpers),
`@basaltkit/subscriptions-proxypay` (ProxyPay driver — production-ready),
`@basaltkit/subscriptions-prisma` / `-sqlite` (durable stores). Card billing is
in [Subscriptions](/guide/billing).
:::

## Money is in minor units — read this first

**Every amount in this ecosystem is an integer in the currency's minor unit**
(cents; `100` = `1.00`). This is the Stripe/Adyen convention: exact, no
floating-point rounding, no ambiguity about units.

```ts
import { toMinor, toMajor, formatMoney, assertMinorUnits } from '@basaltkit/subscriptions'

toMinor(5000, 'AOA')   // 500000   — 5.000,00 Kz as minor units
toMinor(29.99, 'USD')  // 2999     — $29.99
toMajor(500000, 'AOA') // 5000
formatMoney(2999, 'USD', 'en-US') // "$29.99"
assertMinorUnits(2999) // ok
assertMinorUnits(29.99) // throws RangeError — a major-unit slip fails fast
```

::: warning At your HTTP / UI boundary
Humans think in Kwanza, not centavos. Convert at the edge: `toMinor(amount,
'AOA')` on the way in, `toMajor` / `formatMoney` on the way out. Everything in
between — gateways, ledger, stores — stays in minor units.
:::

## Architecture at a glance

```
                       ┌─────────────────────────────────────────┐
  createPayment(req) ─▶│ PaymentGateway  (ProxyPay / AppyPay / …) │◀─ verifyWebhook(raw, sig)
                       └─────────────────────────────────────────┘
                                        │  PaymentInstruction / PaymentEvent
                                        ▼
                       ┌─────────────────────────────────────────┐
                       │ PaymentLedger                           │
                       │  • records payments (pending → paid)    │──▶ PaymentStore (Prisma / SQLite)
                       │  • idempotent apply (dedupe by event.id)│──▶ WebhookStore (Redis / SQL)
                       │  • lifecycle hooks (recorded/confirmed) │
                       └─────────────────────────────────────────┘
                                        ▲
                       ┌─────────────────────────────────────────┐
                       │ RecurringReferenceBilling               │
                       │  one reference per period → paidThrough │──▶ RecurringStore (Prisma / SQLite)
                       └─────────────────────────────────────────┘
```

## Install

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-proxypay
# durable stores — pick one:
pnpm add @basaltkit/subscriptions-prisma   # Postgres / MySQL / SQLite via Prisma
pnpm add @basaltkit/subscriptions-sqlite   # node:sqlite, zero deps
```

## The `PaymentGateway` contract

Everything is expressed in three shapes and one interface.

```ts
interface PaymentRequest {
  billableId: string          // who is paying — you reconcile against this
  amount: number              // MINOR units (integer)
  currency?: string           // ISO 4217; defaults to the gateway's own (AOA)
  reference?: string          // your order/invoice id
  description?: string
  customer?: { name?: string; email?: string; phone?: string }
  expiresAt?: number          // epoch ms — when the reference stops being payable
  metadata?: Record<string, string> // echoed back on the webhook
}

interface PaymentInstruction {
  id: string                  // the gateway's payment id (for reconciliation)
  status: 'pending' | 'paid' | 'failed'
  reference?: { entity: string; reference: string; amount: number } // Multicaixa
  url?: string                // hosted redirect
  push?: { phone: string }    // a prompt was sent to this phone
  raw?: unknown
}

interface PaymentEvent {
  id: string                  // unique gateway event id — for idempotency
  type: 'payment.succeeded' | 'payment.failed'
  paymentId: string           // matches PaymentInstruction.id
  amount: number              // MINOR units
  billableId?: string
  reference?: string
  raw?: unknown
}

interface PaymentGateway {
  readonly name: string
  createPayment(request: PaymentRequest): Promise<PaymentInstruction>
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null
  getPayment?(id: string): Promise<PaymentInstruction>
}
```

For tests, `FakePaymentGateway` is an in-process driver — no network:

```ts
import { FakePaymentGateway } from '@basaltkit/subscriptions'

const gw = new FakePaymentGateway()
const inst = await gw.createPayment({ billableId: 'acme', amount: 500000 })
// verifyWebhook accepts signature === 'valid' and parses the body as a PaymentEvent
```

## 1 · Create a payment (ProxyPay)

```ts
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'

const payments = new ProxyPayGateway({
  apiKey: process.env.PROXYPAY_API_KEY!, // Authorization: Token <key>
  entity: process.env.PROXYPAY_ENTITY!,  // your Multicaixa Entity
  sandbox: process.env.NODE_ENV !== 'production',
  // webhookSecret defaults to the API key (what ProxyPay signs with); '' disables.
})

const inst = await payments.createPayment({
  billableId: 'tenant_42',
  amount: 500000,            // 5.000,00 Kz in minor units
  description: 'Plano Pro — Agosto',
})

// inst.reference = { entity: '00362', reference: '739365427', amount: 500000 }
// Show the customer: Entidade 00362 · Referência 739365427 · 5.000,00 Kz
```

ProxyPay **requires an expiry** and a numeric reference. The driver handles
both: it always sends `end_datetime` (from `expiresAt` or the `expiryDays`
option, default 30), and it reserves a numeric reference unless you pass a
numeric `reference` of your own. A non-numeric `reference` (e.g. an order id) is
kept in `custom_fields` while ProxyPay assigns the numeric one.

### ProxyPay options

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Sent as `Authorization: Token <key>` |
| `entity` | — | Your Multicaixa Entity (Entidade) |
| `sandbox` | `false` | Use the sandbox host |
| `baseUrl` | prod/sandbox | Override the host entirely |
| `webhookSecret` | `apiKey` | HMAC secret; `''` to disable verification |
| `callbackUrl` | — | Echoed as `custom_fields.callback_url` per reference |
| `expiryDays` | `30` | Fallback expiry when `expiresAt` is omitted |
| `fetch` | global `fetch` | Injectable HTTP client |

## 2 · Receive the webhook

When a reference is paid, ProxyPay `POST`s a **flat** JSON body (top-level
`reference_id`, `amount`, `id`, `custom_fields`) signed with **HMAC-SHA256** in
the **`x-signature`** header. `verifyWebhook` validates it and returns a
`PaymentEvent`.

```ts
import { route } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/webhooks/proxypay',
  async handler({ request, reply }) {
    const raw = rawBody(request)            // the EXACT bytes — see the warning below
    const sig = request.headers['x-signature']
    let event
    try {
      event = payments.verifyWebhook(raw, Array.isArray(sig) ? sig[0] : sig)
    } catch {
      return reply.code(400).send({ error: 'invalid signature' }) // WebhookInvalidError
    }
    if (event?.type === 'payment.succeeded') {
      await activate(event.billableId!, event.paymentId)
    }
    return reply.code(200).send({ ok: true }) // always 200 so ProxyPay marks it delivered
  },
})
```

::: warning Sign over the raw body
The HMAC is computed over the **exact bytes** ProxyPay sent. Most JSON parsers
discard them. Two safe options: capture the raw request body (a `rawBody`
plugin), or re-serialize the parsed body — `JSON.stringify(request.body)` is
byte-identical for ProxyPay's compact, stable-key JSON (verified against real
callbacks), and it's what a known-good production integration does.
:::

`verifyWebhook` returns `null` for anything that isn't a payment (no
`reference_id`), so you can pass every callback through it safely.

## 3 · The payment ledger — idempotency, records, hooks

Raw `createPayment` + `verifyWebhook` work, but every real app then needs the
same three things: **store** the payment, apply the webhook **exactly once**
(gateways retry), and **react** to confirmations. `PaymentLedger` is that layer.

```ts
import { PaymentLedger } from '@basaltkit/subscriptions'

const ledger = new PaymentLedger() // in-memory by default; pass { store, webhooks } for durable

// on checkout — record it as pending
const inst = await payments.createPayment(request)
await ledger.created(inst, request)

// in the webhook route — apply it exactly once
const event = payments.verifyWebhook(raw, sig)
if (event) {
  const { fresh, record } = await ledger.apply(event)
  // fresh === false → a duplicate callback; you already handled it
}

// read current status (for a polling UI)
const rec = await ledger.get(reference) // { id, status, amount, createdAt, updatedAt, ... }
```

### Idempotency

`apply` claims `event.id` in a `WebhookStore` before doing anything. A repeated
callback returns `{ fresh: false }` and changes nothing. If persistence throws,
the claim is **released** so the gateway's retry can reprocess.

### Atomic domain side effects

Pass an `onFresh` callback to run **inside** the idempotency claim — for a side
effect that must apply exactly once with the payment (activate a subscription,
mark a booking paid). If it throws, the whole thing is released and retried.

```ts
await ledger.apply(event, async (record, event) => {
  await bookings.markPaid(record!.reference!) // atomic with the payment
})
```

### Lifecycle hooks

For **best-effort** side effects (notifications, analytics) that must never roll
back a payment, subscribe with `on(...)`. Listeners run *after* the payment is
safely persisted, fire only on a **fresh** apply, and a throwing one is reported
via `onListenerError` — never rolled back.

```ts
const ledger = new PaymentLedger({
  store, webhooks,
  onListenerError: (err, event) => log.error({ err, event }, 'payment listener failed'),
})

ledger.on('recorded',  ({ payment }) => analytics.track('payment_started', payment))
const off = ledger.on('confirmed', async ({ record, event }) => {
  await email.send(record!.billableId!, 'Pagamento confirmado')
})
ledger.on('failed', ({ event }) => log.warn({ event }, 'payment failed'))
// off() to unsubscribe
```

| Event | Fires | Payload |
| --- | --- | --- |
| `recorded` | `created()` | `{ record, payment }` |
| `confirmed` | fresh `apply` of `payment.succeeded` | `{ record, event }` |
| `failed` | fresh `apply` of `payment.failed` | `{ record, event }` |

## 4 · Durable stores

In production the ledger is backed by your database. Two contracts —
`PaymentStore` (the ledger) and `WebhookStore` (the dedupe claims) — with drop-in
implementations.

### Prisma (Postgres / MySQL)

Copy the `Payment` + `RecurringSubscription` models from
`@basaltkit/subscriptions-prisma/prisma/schema.prisma` into your schema
(`prisma generate`), then:

```ts
import { PaymentLedger } from '@basaltkit/subscriptions'
import { prismaPaymentStores, PrismaWebhookStore } from '@basaltkit/subscriptions-prisma'

const stores = prismaPaymentStores(prisma) // { payments, recurring }

const ledger = new PaymentLedger({
  store: stores.payments,
  webhooks: new PrismaWebhookStore(prisma), // dedupe via the webhook_events table
})
```

Money is stored as **`BigInt`** (minor units) to avoid the 32-bit `Int` ceiling;
`create` is an atomic `skipDuplicates` insert and `setStatus`/`save` fall back to
an update on a concurrent unique-violation (P2002) — safe under load.

### SQLite (`node:sqlite`)

Same interface, zero external dependencies (Node 22.5+ / 24):

```ts
import { sqlitePaymentStores } from '@basaltkit/subscriptions-sqlite'

const stores = sqlitePaymentStores('./data/billing.db') // { db, payments, recurring }
const ledger = new PaymentLedger({ store: stores.payments /* webhooks default to memory */ })
```

### The Redis hot-path (recommended at scale)

Webhook dedupe is a **high-frequency, tiny** operation — the ideal Redis
workload. Keep the ledger (source of truth) in SQL and move the **dedupe** to
Redis `SET NX` with a TTL. This is the recommended production topology.

```ts
import { RedisWebhookStore } from '@basaltkit/subscriptions'
import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL!)

const ledger = new PaymentLedger({
  store: prismaPaymentStores(prisma).payments,       // ledger  → Postgres (durable)
  webhooks: new RedisWebhookStore(redis, { ttlSeconds: 7 * 24 * 3600 }), // dedupe → Redis
})
```

`RedisWebhookStore` uses an atomic `SET key value NX EX` — the claim succeeds for
exactly one caller across instances, and the TTL auto-expires old claims so the
keyspace never grows unbounded.

| Backend | Ledger | Dedupe | When |
| --- | --- | --- | --- |
| `subscriptions-sqlite` | ✅ | ✅ | Single node, zero deps |
| `subscriptions-prisma` | ✅ | ✅ | Postgres / MySQL |
| `RedisWebhookStore` | — | ✅ | High-throughput dedupe (pair with a SQL ledger) |

## 5 · Recurring billing (no card-on-file)

Reference gateways can't charge a stored card, so a subscription is modelled as
**one reference per period**: issue a reference each period; when its webhook
confirms, extend the subscription's `paidThrough` by one interval.
`RecurringReferenceBilling` coordinates it.

```ts
import { RecurringReferenceBilling } from '@basaltkit/subscriptions'

const billing = new RecurringReferenceBilling({
  gateway: payments,            // your PaymentGateway
  ledger,                       // the PaymentLedger above (shared → idempotency)
  store: stores.recurring,      // RecurringStore (Prisma / SQLite)
  leadDays: 5,                  // becomes "due" this many days before period end
})

// Subscribe → issues the first reference to pay
const { subscription, instruction } = await billing.subscribe({
  billableId: 'tenant_42',
  plan: 'pro',
  amount: 250000,               // 2.500,00 Kz per period (minor units)
  interval: 'monthly',          // 'monthly' | 'yearly'
})

// In the webhook route — apply the event; a paid reference extends paidThrough
const event = payments.verifyWebhook(raw, sig)
if (event) {
  const { applied, subscription } = await billing.handleEvent(event)
}

// On a schedule (cron / a timer): issue the next reference for due subscriptions
for (const sub of await billing.due()) {
  const next = await billing.issueNext(sub.billableId) // email next.reference to the customer
}
```

`handleEvent` is the single entry point for the webhook — it applies the ledger
(idempotently) **and** extends the matching subscription. Non-recurring one-off
payments pass through it harmlessly (recorded, no subscription touched).

| Method | Does |
| --- | --- |
| `subscribe(input)` | Create the subscription + issue the first reference |
| `issueNext(billableId)` | Issue the next period's reference |
| `handleEvent(event)` | Apply once; extend `paidThrough` on success, `past_due` on failure |
| `due(now?)` | Subscriptions needing their next reference (within `leadDays`) |
| `get` / `cancel` | Read / cancel a subscription |

::: tip Scheduling
Run `due()` → `issueNext()` from a cron job, a repeatable [queue](/guide/queues)
job, or a simple `setInterval` in a plugin's `boot`. Keep the interval well above
your gateway's rate limit.
:::

## Full example — wiring it together

A self-contained plugin that registers the gateway, a durable ledger with Redis
dedupe, recurring billing, and a confirmation hook.

```ts
import { createToken, definePlugin } from '@basaltkit/core'
import { PaymentLedger, RecurringReferenceBilling, RedisWebhookStore } from '@basaltkit/subscriptions'
import { prismaPaymentStores } from '@basaltkit/subscriptions-prisma'
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'
import { Redis } from 'ioredis'
import type { PrismaClient } from '@prisma/client'

export const LEDGER = createToken<PaymentLedger>('app:ledger')
export const BILLING = createToken<RecurringReferenceBilling>('app:billing')

export function paymentsPlugin(prisma: PrismaClient, redis: Redis) {
  const stores = prismaPaymentStores(prisma)
  const gateway = new ProxyPayGateway({
    apiKey: process.env.PROXYPAY_API_KEY!,
    entity: process.env.PROXYPAY_ENTITY!,
  })
  const ledger = new PaymentLedger({
    store: stores.payments,
    webhooks: new RedisWebhookStore(redis),
  })
  const billing = new RecurringReferenceBilling({ gateway, ledger, store: stores.recurring })

  return definePlugin({
    name: 'app:payments',
    register({ container }) {
      container.singleton(LEDGER, () => ledger)
      container.singleton(BILLING, () => billing)
    },
    boot() {
      // one place to react to every confirmed payment (one-off or recurring)
      ledger.on('confirmed', async ({ event }) => {
        // notify, invoice, analytics…
      })
    },
  })
}
```

## Providers

| Provider | Package | Status |
| --- | --- | --- |
| **ProxyPay** (Multicaixa references) | `@basaltkit/subscriptions-proxypay` | Production-ready, validated against the live API |
| **AppyPay** (Express push, references, cards) | `@basaltkit/subscriptions-appypay` | **Pre-release** — wire details pending sandbox validation |

### Writing your own driver

Implement `PaymentGateway`. Translate to your provider's format in
`createPayment`, and its webhook to a `PaymentEvent` in `verifyWebhook`
(returning `null` for anything that isn't a payment, throwing `WebhookInvalidError`
on a bad signature). **Amounts arrive in minor units** — convert to the
provider's format with `toMajor`, and back with `toMinor`:

```ts
import { assertMinorUnits, toMajor, toMinor, WebhookInvalidError } from '@basaltkit/subscriptions'

class MyGateway implements PaymentGateway {
  readonly name = 'my-provider'
  async createPayment(req: PaymentRequest): Promise<PaymentInstruction> {
    assertMinorUnits(req.amount)
    const providerAmount = toMajor(req.amount, req.currency ?? 'AOA') // e.g. 500000 → 5000.00
    // …call the provider, map the response…
    return { id, status: 'pending', reference: { entity, reference, amount: req.amount } }
  }
  verifyWebhook(raw: string, sig: string | undefined): PaymentEvent | null {
    // …verify sig or throw WebhookInvalidError; return null if not a payment…
    return { id, type: 'payment.succeeded', paymentId, amount: toMinor(providerAmount, 'AOA') }
  }
}
```

## Errors

| Error | Meaning |
| --- | --- |
| `WebhookInvalidError` | Signature verification failed — respond `400` |
| `ProxyPayRequestError` | A ProxyPay API call failed; carries `httpStatus` |
| `RangeError` (from `assertMinorUnits`) | An amount wasn't a non-negative integer in minor units |

## See also

- [Subscriptions](/guide/billing) — card billing, plans, trials, feature limits
- [Webhooks](/guide/webhooks) — the general webhook delivery/verification guide
- [Persistence & durable stores](/guide/persistence) — the store pattern across Basalt
