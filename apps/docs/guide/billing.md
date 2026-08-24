# Subscriptions

`@basaltkit/subscriptions` models billing in your own database, with payment
gateways as drivers. Your app talks to Basalt; only drivers talk to Stripe,
Paddle, Lemon Squeezy — or, for Angola, ProxyPay/Multicaixa. Feature checks and
quotas read local state, so they are instant and never call the gateway.

[[toc]]

## Define plans

A plan is a price plus a set of features. `definePlans` preserves the exact
types so `subscriptions.features(...)` and the route guards know your feature
names. `meter(n)` wraps a number into a monthly-reset quota.

```ts
// src/billing/plans.ts
import { definePlans, meter } from '@basaltkit/subscriptions'

export const plans = definePlans({
  free: {
    price: 0, // 0 = free, never touches the gateway
    features: { projects: 3, api: false },
  },
  pro: {
    price: { monthly: 29, yearly: 290 }, // per-period pricing
    trial: '14d',                        // 14-day trial → status 'trialing'
    features: {
      projects: 50,                 // lifetime balance
      api: true,                    // on/off flag
      'api.requests': meter(100_000), // quota that resets every calendar month
    },
  },
  scale: {
    price: 'custom', // "talk to sales" — no self-serve checkout
    features: { projects: Number.POSITIVE_INFINITY, api: true },
  },
})
```

Feature values speak for themselves:

| Value | Meaning |
| --- | --- |
| `boolean` | On/off flag (`can(feature)`) |
| `number` | Lifetime consumable balance — never resets |
| `meter(n)` | Quota that resets every calendar month (bucket `YYYY-MM`) |
| `Infinity` | Unlimited |

`price` is `0` (free), a single `number` (same in both periods), a
`{ monthly, yearly }` object, or `'custom'` (sales-led — checkout is disabled).

## Wire the plugin

`subscriptionsPlugin` registers the service under the `SUBSCRIPTIONS` token and
installs the `meta.subscribed` / `meta.feature` route guards. Its options are
the same as `new Subscriptions(...)` minus `hooks` (the plugin passes the app's
`HookBus` automatically).

```ts
// src/billing/subscriptions.ts
import { Subscriptions } from '@basaltkit/subscriptions'
import { plans } from './plans.js'

// Standalone service (no HTTP, no gateway) — everything works locally.
export const subscriptions = new Subscriptions({
  plans,
  fallbackPlan: 'free', // applied to anyone without a subscription
})
```

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `plans` | `Plans` | — | Your plan catalog (required) |
| `fallbackPlan` | `string` | — | Plan for those with no subscription |
| `gateway` | `BillingGateway` | — | Stripe/Paddle driver for card subscriptions |
| `store` | `SubscriptionStore` | in-memory | Where subscriptions are persisted |
| `usage` | `UsageStore` | in-memory | Metering counters (atomic `consume`) |
| `webhooks` | `WebhookStore` | in-memory | Webhook dedupe by event id |

## Subscribe and manage

The billable is the tenant by convention — `'acme'` below is a tenant id.

```ts
await subscriptions.subscribe('acme', 'pro')                       // monthly (default)
await subscriptions.subscribe('acme', 'pro', { period: 'yearly' }) // yearly

await subscriptions.swap('acme', 'scale')                    // change plan, with proration
await subscriptions.swap('acme', 'scale', { prorate: false }) // change at next renewal only

await subscriptions.cancel('acme')                         // at period end (stays active until then)
await subscriptions.cancel('acme', { atPeriodEnd: false })  // immediate → status 'canceled'
await subscriptions.resume('acme')                          // undo a scheduled cancellation

await subscriptions.subscribed('acme')        // true if active or in a valid trial
await subscriptions.subscribed('acme', 'pro') // ...on a specific plan
await subscriptions.onTrial('acme')           // boolean
await subscriptions.get('acme')               // SubscriptionRecord | null
```

A `SubscriptionRecord` is `{ billableId, plan, period, status, trialEndsAt?,
cancelAtPeriodEnd?, canceledAt?, gatewayRef? }` where `status` is one of
`active`, `trialing`, `past_due`, `canceled`, `incomplete`.

## Feature limits and metering

`features(billableId)` returns the enforcement API. It reads local state only,
so it is instant and safe to call on every request.

```ts
const features = subscriptions.features('acme')

await features.can('api')            // true on pro
await features.limit('projects')     // 50 (false→0, true→Infinity)
await features.usage('projects')     // consumed so far this period
await features.remaining('projects') // limit − usage

// Records consumption atomically — safe under concurrency.
await features.consume('projects', 2)      // create 2 projects
await features.consume('api.requests', 1)  // metered; resets monthly
```

`consume` throws `QuotaExceededError` (`BILLING_QUOTA_EXCEEDED`, 402) when the
limit runs out, and `FeatureUnavailableError` (`BILLING_FEATURE_UNAVAILABLE`,
403) when the plan does not grant the feature at all. Catch these to show an
upgrade prompt:

```ts
import { QuotaExceededError, FeatureUnavailableError } from '@basaltkit/subscriptions'

try {
  await features.consume('api.requests', 1)
} catch (err) {
  if (err instanceof QuotaExceededError) return reply.code(402).send({ upgrade: true })
  if (err instanceof FeatureUnavailableError) return reply.code(403).send({ upgrade: true })
  throw err
}
```

::: tip Meters vs. balances
`meter(n)` resets every calendar month; a plain `number` is a lifetime balance
that never resets. Pick the number type deliberately — it is the difference
between "1000 API calls per month" and "1000 API calls ever".
:::

## Guard routes

Attach requirements as route `meta`. The guard resolves the billable from the
request's tenant and rejects before your handler runs.

```ts
import { route } from '@basaltkit/fastify'

route({ method: 'GET', url: '/reports', meta: { subscribed: 'pro' }, async handler() {
  return { ok: true }
}})

route({ method: 'GET', url: '/api/data', meta: { feature: 'api' }, async handler() {
  return { data: [] }
}})
```

`meta: { subscribed: true }` requires any active subscription;
`meta: { subscribed: 'pro' }` requires that specific plan. Unmet requirements
return `402 BILLING_SUBSCRIPTION_REQUIRED` or `403 BILLING_FEATURE_UNAVAILABLE`.

## Stripe: checkout, portal, webhook

The Stripe driver targets the Stripe REST API directly (no `stripe` SDK) and
verifies webhook signatures with Node's crypto. Tell it how to map plans to
Stripe Price IDs and how to resolve each tenant's Stripe Customer ID.

```ts
// src/billing/gateway.ts
import { StripeBillingGateway } from '@basaltkit/subscriptions'

const PRICE_IDS = {
  pro: { monthly: 'price_pro_m', yearly: 'price_pro_y' },
} as const

export const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_...
  priceId: (plan, period) => PRICE_IDS[plan as 'pro'][period],
  customerId: (tenantId) => getOrCreateStripeCustomer(tenantId),
})
```

Wire the gateway into the plugin and register the ready-made billing routes.
`billingRoutes` gives you hosted **Checkout** and the self-service **Portal**;
`billingWebhookRoute` gives you the endpoint Stripe calls back.

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import {
  billingRoutes,
  billingWebhookRoute,
  subscriptionsPlugin,
} from '@basaltkit/subscriptions'
import { plans } from './billing/plans.js'
import { gateway } from './billing/gateway.js'

const app = await createApp({
  plugins: [
    // ... your tenancy plugin, which sets context.tenant ...
    subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
    fastifyPlugin({
      routes: [
        ...billingRoutes({
          successUrl: 'https://app.example.com/thank-you',
          cancelUrl: 'https://app.example.com/pricing',
          // portalReturnUrl: 'https://app.example.com/account',
        }),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

Routes registered:

| Route | Body | Returns |
| --- | --- | --- |
| `POST /billing/checkout` | `{ plan, period?, successUrl?, cancelUrl? }` | `{ url }` — redirect the customer here |
| `POST /billing/portal` | `{ returnUrl? }` (optional) | `{ url }` |
| `POST /billing/webhook` | raw gateway payload | `{ received, duplicate }` |

The lifecycle: Checkout creates an `incomplete` subscription and returns a URL;
the customer pays on Stripe's hosted page; the `payment.succeeded` webhook flips
it to `active`. Webhook processing is idempotent by event id — a duplicate
delivery returns `{ duplicate: true }` and changes nothing.

Prefer to drive it yourself instead of the routes? The service methods are
public:

```ts
const { url } = await subscriptions.checkout('acme', 'pro', {
  successUrl: 'https://app.example.com/thank-you',
  cancelUrl: 'https://app.example.com/pricing',
})
const portal = await subscriptions.portal('acme', { returnUrl: 'https://app.example.com/account' })
```

::: warning Raw body required
Stripe verifies the signature against the **untouched** request bytes. Configure
a raw-body parser for the webhook route so the handler receives the original
string — re-serializing a parsed object breaks the HMAC. A 400
`BILLING_WEBHOOK_INVALID` that won't go away is almost always this.
:::

For development and tests there is `FakeBillingGateway`, which records every call
in arrays (`created`, `canceled`, `checkouts`, `portals`, `swaps`) and accepts
the webhook signature `'valid'`.

## Invoices

A subscription says *what* a tenant is entitled to; an **invoice** is the record
of *what they were charged* for a period — line items, discount, tax, totals and
a payment status. The engine is pure domain (no HTTP, no gateway), so it behaves
the same behind any adapter or payment driver.

The lifecycle is `draft → open → paid`, and a draft or open invoice can be
`void`ed. **All amounts are integer minor units** (cents), consistent with the
rest of billing.

```ts
import { Invoices, planLine, overageLine } from '@basaltkit/subscriptions'

const invoices = new Invoices({ taxRate: 0.14 }) // 14% VAT by default

// Build from the plan + any metered overage this period
const draft = await invoices.draft({
  billableId: tenantId,
  currency: 'USD',
  lineItems: [
    planLine('pro', plans.pro, 'monthly'),                       // $29.00 base
    overageLine('api.calls', { used: 1500, included: 1000, unitAmount: 2 })!, // 500 × $0.02
  ],
  discount: 500,        // $5.00 off, applied before tax
})

const open = await invoices.finalize(draft.id) // assigns INV-2026-0001, status → open
await invoices.markPaid(open.id, { paymentId: 'pay_123' }) // once the gateway confirms
```

`overageLine()` returns `null` when usage is within the allowance (so spread it
and filter, or use it only when over). `planLine()` throws for a `'custom'`
(sales-led) price — those have no self-serve amount.

### Settling from a payment webhook

Invoices don't talk to gateways. When your payment confirms (via `handleWebhook`
or the `PaymentLedger`'s `confirmed` event), call `markPaid`:

```ts
ledger.on('confirmed', async ({ record }) => {
  if (record?.reference) await invoices.markPaid(record.reference, { paymentId: record.id })
})
```

### Exposing invoices over HTTP

`invoiceRoutes()` adds read-only, tenant-scoped endpoints, built on the neutral
`route()` — so they serve identically on **Fastify, Express and Hono**:

```ts
import { subscriptionsPlugin, invoiceRoutes } from '@basaltkit/subscriptions'

createApp({
  plugins: [
    subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway, invoices: { taxRate: 0.14 } }),
    fastifyPlugin({ routes: [...invoiceRoutes()] }), // or expressPlugin / honoPlugin
  ],
})
```

| Route | Returns |
| --- | --- |
| `GET /billing/invoices` | `{ data: Invoice[] }` for the current tenant, newest first |
| `GET /billing/invoices/:id` | one invoice as JSON (404 if it isn't the tenant's) |
| `GET /billing/invoices/:id/html` | a printable HTML invoice |

Resolve the `INVOICES` token (or your own `Invoices` instance) to issue and
finalize invoices server-side; the routes are deliberately read-only. Back the
engine with a durable `InvoiceStore` in production — the default is in-memory.

Render anywhere with `renderInvoiceText(invoice)` (receipts, emails) or
`renderInvoiceHtml(invoice)` (self-contained, no external assets). For **PDF**, add
[`@basaltkit/subscriptions-pdf`](https://www.npmjs.com/package/@basaltkit/subscriptions-pdf)
and call `renderInvoicePdf(invoice, { businessName })` → a `Buffer` (keeps pdfkit
out of the dependency-free core).

## Durable stores

The default stores are in-memory and per-process — fine for a single node or a
test, wrong for production, where usage counters must be atomic across
processes. Two drop-in packages provide durable stores.

### SQLite (`@basaltkit/subscriptions-sqlite`)

Backed by Node's built-in `node:sqlite`. `sqliteSubscriptionsStores` opens (or
creates) the database, applies the schema, and returns all three stores named to
drop straight into the plugin.

```ts
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { plans } from './billing/plans.js'

const s = sqliteSubscriptionsStores('./data/billing.db')

subscriptionsPlugin({
  plans,
  fallbackPlan: 'free',
  store: s.store,
  usage: s.usage,
  webhooks: s.webhooks,
})
```

### Prisma (`@basaltkit/subscriptions-prisma`)

For PostgreSQL, MySQL and friends. Bring a `PrismaClient` whose schema includes
the `Subscription`, `UsageCounter` and `WebhookEvent` models (a
`prisma/schema.prisma` ships with the package).

```ts
import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { PrismaClient } from '@prisma/client'
import { plans } from './billing/plans.js'

const prisma = new PrismaClient()
const s = prismaSubscriptionsStores(prisma)

subscriptionsPlugin({ plans, fallbackPlan: 'free', ...s })
```

The metered `consume()` is atomic: a conditional `updateMany` increments only
while `value <= limit - amount` holds, and the row lock serializes concurrent
callers — so a quota is never overshot.

::: tip Redis alternative
If you already run Redis, `RedisUsageStore` and `RedisWebhookStore` (from
`@basaltkit/subscriptions`) give the same guarantees: check-and-increment in a
single `EVAL` (Lua) round trip, and durable dedupe via `SET NX`.
:::

## Trials

For a paid plan with a `trial`, a configured gateway creates the subscription
with the trial period up front and charges at trial end, sending the webhook
that flips `trialing → active` (or `past_due` on a failed charge).

Without a gateway, trials are local: run `expireTrials()` from the scheduler to
settle them. A free plan graduates to `active`; a paid one lands in `past_due`
(there is no way to charge). Gateway-backed trials are deliberately left to the
gateway's webhook — `expireTrials()` ignores them.

```ts
// e.g. from @basaltkit/scheduler
const settled = await subscriptions.expireTrials()
```

## Angolan / reference payments (PaymentGateway)

::: tip Full guide
This is a summary. For the complete story — the money model, the idempotent
ledger, lifecycle hooks, durable Prisma/SQLite stores, the Redis dedupe
hot-path, and recurring billing — see
**[Reference & mobile-money payments](/guide/reference-payments)**.
:::

Stripe's `BillingGateway` models **card-on-file subscriptions**. Angolan
providers work differently: there is no stored card and no self-service portal.
The customer pays a **Reference** at an ATM, on Multicaixa Express, or in a bank
app, using your account's fixed **Entity (Entidade)** — and the provider
confirms by webhook. Basalt models this with a separate contract,
`PaymentGateway`, whose driver for ProxyPay ships as
`@basaltkit/subscriptions-proxypay`.

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-proxypay
```

A `PaymentGateway` has two methods: `createPayment(request)` reserves a payment
and returns a `PaymentInstruction` (what to show the customer), and
`verifyWebhook(rawBody, signature)` translates the provider's callback into a
`PaymentEvent` (`payment.succeeded` / `payment.failed`) or `null` for events you
don't act on.

### Construct the gateway

```ts
// src/billing/payments.ts
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'

export const payments = new ProxyPayGateway({
  apiKey: process.env.PROXYPAY_API_KEY!,        // sent as `Authorization: Token <key>`
  entity: process.env.PROXYPAY_ENTITY!,         // your Multicaixa Entity (Entidade)
  sandbox: process.env.NODE_ENV !== 'production', // api.sandbox.proxypay.co.ao
  webhookSecret: process.env.PROXYPAY_WEBHOOK_SECRET, // HMAC-SHA256, optional
})
```

| Option | Type | Purpose |
| --- | --- | --- |
| `apiKey` | `string` | Sent as `Authorization: Token <apiKey>` (required) |
| `entity` | `string` | Your Multicaixa Entity, assigned by ProxyPay/EMIS (required) |
| `sandbox` | `boolean` | Use the sandbox host. Default `false` (production) |
| `baseUrl` | `string` | Override the base URL entirely |
| `webhookSecret` | `string` | Shared secret for HMAC-SHA256 webhook verification |
| `fetch` | `FetchLike` | Injected fetch; defaults to the global `fetch` |

### Create a payment and show the reference

`createPayment` reserves a reference and returns the entity + reference to put in
front of the customer. Amounts are AOA in the major unit (`5000` = 5.000,00 Kz).

```ts
import { payments } from './billing/payments.js'

const instruction = await payments.createPayment({
  billableId: 'acme',              // echoed back on the webhook for reconciliation
  amount: 5000,                    // 5.000,00 Kz
  reference: 'invoice_2026_08',    // your order/invoice id
  expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, // payable for 3 days
})

// instruction.reference = { entity: '00123', reference: '900000001', amount: 5000 }
// Show: "Entidade 00123 · Referência 900000001 · 5.000,00 Kz"
```

A `PaymentInstruction` is `{ id, status: 'pending' | 'paid' | 'failed',
reference?, url?, push?, raw? }`. ProxyPay is reference-based, so it populates
`reference` (`{ entity, reference, amount }`); redirect- or push-based providers
would populate `url` or `push` instead.

### Receive the webhook

Point your ProxyPay `payment` webhook at a route, pass the **raw** body to
`verifyWebhook`, and act on `payment.succeeded`. This is a plain HTTP route, not
`billingWebhookRoute` (that one is for card `BillingGateway` drivers).

```ts
import { FASTIFY } from '@basaltkit/fastify'
import { payments } from './billing/payments.js'
import { subscriptions } from './billing/subscriptions.js'

const fastify = app.container.get(FASTIFY)

fastify.post('/webhooks/proxypay', async (request, reply) => {
  const raw = request.rawBody as string // exact bytes — needed for the signature
  const event = payments.verifyWebhook(raw, request.headers['x-signature'] as string | undefined)

  if (event?.type === 'payment.succeeded') {
    // event = { id, type, paymentId, amount, billableId?, reference?, raw? }
    await subscriptions.subscribe(event.billableId!, 'pro', { period: 'monthly' })
  }

  reply.code(200).send()
})
```

`verifyWebhook` throws `WebhookInvalidError` (HTTP 400) on a bad signature and
returns `null` for verified events that aren't payments. Deduplicate on
`event.id` if you want idempotency across retries.

::: warning Raw body required
Just like Stripe, signature verification runs over the untouched request bytes.
Register the route with a raw-body parser so `request.rawBody` holds the
original string.
:::

::: tip Recurring = one reference per period
ProxyPay has no card-on-file recurring charge. Model recurring billing by
issuing **one reference per period**: when a period ends (or on each invoice),
call `createPayment` again for the next period, and activate that period only
when its `payment.succeeded` webhook arrives. There is no `getPayment` polling
fallback in the ProxyPay driver — rely on the webhook.
:::

For development and tests, `FakePaymentGateway` (from `@basaltkit/subscriptions`)
implements the same contract in-process: it records requests in `payments` and
its `verifyWebhook` returns a synthetic `payment.succeeded`.

## Domain hooks

The plugin emits hooks on the app's `HookBus` — `billing:subscribed`,
`billing:checkout_started`, `billing:swapped`, `billing:canceled`,
`billing:trial_expired`, `billing:webhook`. Subscribe to send emails or
notifications:

```ts
app.hooks.on('billing:trial_expired', ({ subscription }) => {
  // mailer.send(...) / notifier.notify(...)
})
```
