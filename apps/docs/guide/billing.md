# Subscriptions

`@basaltkit/subscriptions` models billing in your own database, with payment
gateways as drivers. Your app talks to Basalt; only drivers talk to Stripe,
Paddle, Lemon Squeezy — or, for Angola, ProxyPay/Multicaixa. Feature checks and
quotas read local state, so they are instant and never call the gateway.

[[toc]]

## Mental model

Billing is five pieces, and knowing which one owns a question answers most of
the rest:

| Piece | Owns | Talks to the gateway? |
| --- | --- | --- |
| **Plans** (`definePlans`) | The catalog: price, trial, features per plan | No — a plain object, read synchronously |
| **`Subscriptions`** (`SUBSCRIPTIONS`) | *What a billable is entitled to right now*: plan, period, status | Only for money moves (subscribe, checkout, portal, swap, cancel) |
| **`features(billableId)`** | Enforcement: `can`, `limit`, `usage`, `remaining`, `consume` | **Never** — reads local state, so it's instant on every request |
| **`Invoices`** (`INVOICES`) | *What they were charged*: line items, discount, tax, totals, status | No — pure domain; you call `markPaid` when a payment confirms |
| **Gateway driver** | Moving money and verifying webhooks | It *is* the gateway |

The direction of truth matters: **your database is the read model.** A gateway
webhook writes into it (`handleWebhook`), and everything else — guards, feature
checks, quota enforcement — reads from it. No request path ever waits on
Stripe.

The **billable** is whatever id you pass. By convention it is the tenant id, and
the route guards and the HTTP routes resolve it from `ctx().tenant.id`, which is
why [tenant-membership enforcement](/guide/teams) is load-bearing for billing —
see the warning in the Stripe section below.

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

### Persisting the plan catalog

Plans are consumed **synchronously** (by `planPrice`, features and the guards),
so keep the source of truth in a `PlanStore` and **load it once at boot**:

```ts
import { loadPlans, subscriptionsPlugin } from '@basaltkit/subscriptions'

const plans = await loadPlans(planStore) // reads your DB, builds the Plans object
subscriptionsPlugin({ plans, fallbackPlan: 'free', ...stores })
```

`MemoryPlanStore` (seed it with a `definePlans` object) ships for tests; back a
real `PlanStore` with your database to manage plans in the DB — edits apply on
restart. `plansToStored(plans)` turns a `definePlans` object into rows for
seeding.

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

The constructor fails fast on a `fallbackPlan` that isn't in the catalog, so a
typo is a boot error rather than a silent "nobody has any features". Every
option is tabled in **Options reference** below.

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
cancelAtPeriodEnd?, canceledAt?, gatewayRef?, pendingPlan?, pendingPeriod? }`
where `status` is one of
`active`, `trialing`, `past_due`, `canceled`, `incomplete`.

## Two doors into a subscription

`subscribe()` and `checkout()` both start a subscription and they do **not**
behave the same way. Reaching for the wrong one is the most common reason a
subscription "silently never works".

| | `subscribe()` | `checkout()` |
| --- | --- | --- |
| Status it leaves behind | `active`, or `trialing` if the plan has a trial | **`incomplete`** |
| Who confirms the payment | nobody — you decided, or the plan is free | the gateway, later, via webhook |
| `subscribed()` immediately after | `true` | **`false`** |
| Reach for it when | granting server-side, free plans, seeding, dev and tests | real self-service card payments |

### `subscribe()` — active the moment it returns

```ts
import { SUBSCRIPTIONS } from '@basaltkit/subscriptions'

const subscriptions = app.container.get(SUBSCRIPTIONS)

const record = await subscriptions.subscribe('acme', 'pro')
record.status                             // 'trialing' — the pro plan declares trial: '14d'
await subscriptions.subscribed('acme')       // true — a valid trial counts as subscribed
await subscriptions.subscribed('acme', 'pro') // true

// A plan with no trial lands straight on 'active'
await subscriptions.subscribe('acme', 'scale')  // status: 'active'

// Yearly instead of the monthly default
await subscriptions.subscribe('acme', 'pro', { period: 'yearly' })

// A free plan never touches the gateway at all
await subscriptions.subscribe('acme', 'free')   // status: 'active', no gateway call
```

Paid plans still call the gateway's `createSubscription` to get a
`gatewayRef` — but the local record is written as active regardless, because
*you* are asserting the subscription exists.

### `checkout()` — two steps, and it is not finished when it returns

```ts
const { url } = await subscriptions.checkout('acme', 'pro', {
  successUrl: 'https://app.example.com/thank-you',
  cancelUrl: 'https://app.example.com/pricing',
})

await subscriptions.get('acme')          // { status: 'incomplete', … }
await subscriptions.subscribed('acme')   // false  ← still false, and correctly so
```

The flow completes only when the gateway calls back:

```
checkout()  →  incomplete  →  [customer pays on the gateway]
                                        ↓
                          POST /billing/webhook  (payment.succeeded)
                                        ↓
                                     active
```

::: danger A URL is not a subscription
`checkout()` returning a URL means a payment page was created — nothing more.
Until a `payment.succeeded` webhook arrives, the record stays `incomplete` and
every `meta.subscribed` guard keeps answering **402
`BILLING_SUBSCRIPTION_REQUIRED`**. If you are testing locally and no real
payment ever happens, that webhook never arrives on its own — see
[Local development](#local-development-without-a-real-gateway) below.
:::

That `incomplete` record is deliberate, and so is the fact that a second
checkout does not overwrite a live subscription. An abandoned checkout parks its
intent in `pendingPlan` / `pendingPeriod`; only a webhook carrying a **new**
`gatewayRef` promotes it. Without that rule, starting a checkout for a cheap
plan and abandoning it could downgrade — or, worse, escalate — an existing
subscription on the next legitimately-signed renewal.

### Which status counts as subscribed

```ts
await subscriptions.subscribed('acme')  // true for 'active' and a valid 'trialing'
```

| Status | `subscribed()` | How you get here |
| --- | :---: | --- |
| `active` | ✅ | `subscribe()`, or a `payment.succeeded` webhook |
| `trialing` | ✅ (while `trialEndsAt` is in the future) | `subscribe()` on a plan with `trial` |
| `incomplete` | ❌ | `checkout()`, awaiting the gateway |
| `past_due` | ❌ | a `payment.failed` webhook |
| `canceled` | ❌ | `cancel({ atPeriodEnd: false })`, or a `subscription.canceled` webhook |

## Local development without a real gateway

`FakeBillingGateway` lets the whole surface run with no Stripe account. It
creates checkout sessions and returns plausible URLs — but nobody ever pays at
`https://fake.test/checkout/…`, so **no webhook is ever sent** and a
`checkout()` never leaves `incomplete` on its own.

Two ways to get an active subscription locally.

### The short way — `subscribe()`

Best for tests, seeds and "I just need this tenant on the pro plan":

```ts
// src/seed.ts, or a dev-only route
await app.container.get(SUBSCRIPTIONS).subscribe('demo', 'pro')
```

```ts
// in a test
const app = await buildApp({ logLevel: 'silent' }).boot()
const subscriptions = app.container.get(SUBSCRIPTIONS)
await subscriptions.subscribe('demo', 'pro')
expect(await subscriptions.subscribed('demo', 'pro')).toBe(true)
```

### The faithful way — post the webhook yourself

Exercises the same code path production uses, which is what you want when the
thing you are actually testing is the webhook handling:

```bash
# 1. start the checkout (needs auth + a tenant — see below)
curl -X POST localhost:3000/billing/checkout \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: demo' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"plan":"pro"}'
# → { "url": "https://fake.test/checkout/fake_cs_1" }   ... status is now 'incomplete'

# 2. play the gateway: confirm the payment
curl -X POST localhost:3000/billing/webhook \
  -H 'content-type: application/json' \
  -H 'x-billing-signature: valid' \
  -d '{"id":"evt_1","type":"payment.succeeded","billableId":"demo","gatewayRef":"fake_sub_1"}'
# → { "received": true, "duplicate": false }            ... status is now 'active'
```

`FakeBillingGateway.verifyWebhook` accepts any JSON body whose signature header
is literally `valid`, and rejects everything else with
`BILLING_WEBHOOK_INVALID`. The event ids are deduplicated durably, so replaying
`evt_1` returns `{ duplicate: true }` and changes nothing — which is exactly how
a real gateway's retries are meant to behave.

The other event types work the same way:

```bash
# a failed renewal → past_due
-d '{"id":"evt_2","type":"payment.failed","billableId":"demo"}'

# the customer cancelled at the gateway → canceled
-d '{"id":"evt_3","type":"subscription.canceled","billableId":"demo"}'
```

::: tip The billable is the tenant, not the user
`billingRoutes` resolves the billable from `context.tenant.id`. A request with
no tenant fails with 402 `BILLING_SUBSCRIPTION_REQUIRED` even when the caller is
perfectly authenticated — the message is about the *tenant* having no
subscription. Send `x-tenant-id`, or whatever your `tenancyPlugin` resolvers
expect.

The write routes also default to `auth: true`, so an unauthenticated
`POST /billing/checkout` is a 401 before any of this is reached.
:::

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

### Metered usage & tiered pricing

Bill consumption with brackets — `graduated` (each unit priced by the bracket it
falls into) or `volume` (all units at the bracket the total lands in) — and turn
recorded usage into an invoice line:

```ts
import { meteredLine, tieredCost } from '@basaltkit/subscriptions'

const price = {
  mode: 'graduated' as const,
  tiers: [
    { upTo: 1000, unitAmount: 2 }, // first 1,000 calls @ $0.02
    { upTo: null, unitAmount: 1 }, // beyond @ $0.01
  ],
}

const line = meteredLine('api.calls', { units: 2_500, includedUnits: 1_000, price })
// → one line for the 1,500 billable units; tieredCost(price, 1500) = 2500 (¢)

await invoices.draft({ billableId, currency: 'USD', lineItems: [line].filter(Boolean) })
```

`includedUnits` (the plan's free allowance) is subtracted first; `meteredLine`
returns `null` when nothing is billable. Use `tieredCost(price, units)` directly
for previews or proration. Tiered pricing has no single per-unit rate, so the line
is a single amount with the breakdown in its `metadata`.

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

Checkout, Portal and the invoice routes are **authenticated by default**
(`meta: { auth: true }`, enforced by `@basaltkit/auth`'s guard) — they mint
live payment-management URLs and payment history for the current tenant and
must never be anonymous. If (and only if) authentication happens at an outer
edge, opt out deliberately with `billingRoutes({ ..., auth: false })` /
`invoiceRoutes({ auth: false })`. The webhook route is the exception: it is
authenticated by the gateway **signature**, never by a session.

::: danger `meta.auth` alone does not isolate tenants
`billingRoutes()` and `invoiceRoutes()` authenticate the **user** but resolve
the **billable from the tenant** (`ctx().tenant.id`) — and the tenant comes from
a header or a `Host`, both client-controlled. Authentication proves *who is
calling*, not *which tenant they belong to*. Register
[`tenantMembershipPlugin()`](/guide/teams) and a valid user of tenant A calling
`/billing/checkout`, `/billing/portal` or `/billing/invoices` with tenant B's
identifier is stopped with `403 TEAM_NOT_A_MEMBER` **before any billing code
runs** — no Checkout session minted against B's plan, no Portal URL to B's card,
no read of B's payment history. Without it, `meta.auth` lets any logged-in user
operate on any tenant's billing. The same applies to your own
`meta: { subscribed }` / `meta: { feature }` routes. See
[Teams](/guide/teams) and the [security guide](/guide/security).
:::

`subscribed` and `feature` **are** part of the framework's guarded-meta check.
`subscriptionsPlugin` claims both keys, so a route annotated
`meta: { subscribed: 'pro' }` with the plugin missing no longer boots and serves
the paid feature to everyone — the adapter refuses to start with
`UnguardedRouteMetaError`, naming the offending routes. If the paywall genuinely
lives at an outer edge, opt out deliberately with the adapter option
`allowUnguardedMeta: ['subscribed', 'feature']`. Still cover the paywall with a
test: the boot check proves a guard is *registered*, not that your plan matrix is
right.

An abandoned Checkout can never change the live subscription: `checkout()`
records the intent as `pendingPlan`, and the plan only switches when the
gateway confirms payment for a **new** gateway subscription — a renewal of the
current subscription (same `gatewayRef`) can't activate an escalated plan.

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

### Coupons & discounts

Define a coupon — `percentOff` (0–100) or a fixed `amountOff` (minor units +
currency), with optional `maxRedemptions` and a `redeemBy` expiry — then apply it
when drafting an invoice:

```ts
import { Coupons } from '@basaltkit/subscriptions'

const coupons = new Coupons()
await coupons.define({ code: 'LAUNCH20', percentOff: 20, maxRedemptions: 100 })

// validate + compute (throws if unknown, expired, capped, or wrong currency)
const { discount } = await coupons.quote('LAUNCH20', subtotalMinor, 'USD')

const invoice = await invoices.draft({
  billableId: tenantId,
  currency: 'USD',
  lineItems: [planLine('pro', plans.pro, 'monthly')],
  coupon: { code: 'LAUNCH20', percentOff: 20 }, // added on top of any explicit discount
})
// → invoice.discount reflects the coupon; invoice.couponCode = 'LAUNCH20'

await coupons.redeem('LAUNCH20') // once the charge succeeds, consume a redemption
```

`quote()` validates redeemability **without** consuming; `redeem()` increments
the counter. A fixed-amount coupon only applies to invoices in its own currency.
Back the registry with a durable `CouponStore` in production (the default is
in-memory).

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
the `Subscription`, `UsageCounter` and `WebhookEvent` models. A
`prisma/schema.prisma` ships with the package — copy it rather than retyping it:

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
  // The plan a checkout INTENDED, held until the gateway confirms payment.
  // Written on EVERY save — see the warning below.
  pendingPlan       String?
  pendingPeriod     String?

  @@map("subscriptions")
}
```

::: danger A stale copy of this model breaks every write
The store writes the full record on every save, `pendingPlan` and
`pendingPeriod` included. A schema copied before those columns existed — they
arrived with the checkout-intent hardening — fails on **every** subscription
write with:

```
Invalid `prisma.subscription.upsert()` invocation:
  pendingPlan: null,
  ~~~~~~~~~~~
Unknown argument `pendingPlan`.
```

Nothing can ever become active, so the visible symptom is the *guard*
complaining — a permanent 402 `BILLING_SUBSCRIPTION_REQUIRED` — while the real
failure happened earlier, in Prisma. If subscriptions never activate, check this
model first.

Add the two columns and `npx prisma db push` (or generate a migration).
:::

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
  // Optional — defaults to apiKey, which is what ProxyPay signs the callback with
  webhookSecret: process.env.PROXYPAY_WEBHOOK_SECRET,
})
```

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (required) | Sent as `Authorization: Token <apiKey>` |
| `entity` | `string` | — (required) | Your Multicaixa Entity, assigned by ProxyPay/EMIS |
| `sandbox` | `boolean` | `false` | Use the sandbox host `api.sandbox.proxypay.co.ao` |
| `baseUrl` | `string` | derived from `sandbox` | Override the base URL entirely |
| `webhookSecret` | `string` | **your `apiKey`** | HMAC-SHA256 (hex) over the raw body, in `x-signature`. Verification is therefore **on out of the box**; pass `''` to disable it entirely |
| `callbackUrl` | `string` | — | Echoed back on the webhook as `custom_fields.callback_url`. ProxyPay's real delivery target is set account-wide in the dashboard |
| `expiryDays` | `number` | `30` | Fallback validity window when `PaymentRequest.expiresAt` is omitted — ProxyPay *requires* an end date, so one is always sent |
| `fetch` | `FetchLike` | global `fetch` | Injected fetch |

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

## Options reference

### `subscriptionsPlugin(options)`

The same options as `new Subscriptions(...)` minus `hooks` (the plugin passes
the app's `HookBus`), plus `invoices`.

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `plans` | `Plans` | — (required) | The catalog from `definePlans` or `loadPlans(store)`. Consumed synchronously, so it must be fully resolved before boot |
| `fallbackPlan` | `string` | — | Plan applied to billables with no subscription (usually `'free'`). Validated at construction — an unknown name throws `UnknownPlanError` immediately |
| `gateway` | `BillingGateway` | — | Card-subscription driver (Stripe, Paddle, Lemon Squeezy). Without one, everything still works locally; only `checkout`/`portal` require it |
| `store` | `SubscriptionStore` | in-memory | Where subscriptions live — swap for `subscriptions-sqlite`/`-prisma` or they vanish on restart |
| `usage` | `UsageStore` | in-memory | Metering counters. The default is per-process, so a quota **can be overshot** across replicas; use SQLite/Prisma/Redis for atomic `consume` |
| `webhooks` | `WebhookStore` | in-memory | Gateway-event dedupe by event id. Per-process by default, which means a retry landing on another replica is reprocessed |
| `invoices` | `InvoicesOptions` | `{}` | Config for the `Invoices` engine registered under `INVOICES` (below) |

### `billingRoutes(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `successUrl` | `string` | — (required) | Where the gateway returns the customer after Checkout. The request body may override it per call |
| `cancelUrl` | `string` | — (required) | Where an abandoned Checkout returns to |
| `portalReturnUrl` | `string` | `successUrl` | Where the Customer Portal returns to |
| `auth` | `boolean` | `true` | Requires `meta: { auth: true }` on both routes. Set `false` **only** when authentication happens at an outer edge — these routes mint live payment-management URLs |

`POST /billing/checkout` takes `{ plan, period?, successUrl?, cancelUrl? }` and
`POST /billing/portal` takes an optional `{ returnUrl }`; both return `{ url }`.

### `invoiceRoutes(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `auth` | `boolean` | `true` | Same rule as `billingRoutes` — invoices are the tenant's payment history |

All three routes are read-only and ownership-checked: an invoice whose
`billableId` isn't the current tenant reads as `404 INVOICE_NOT_FOUND`, never as
someone else's data. Issuing and finalizing stay server-side through `INVOICES`.

### `billingWebhookRoute(gateway)`

Takes the gateway instance as its only argument — no options. It is deliberately
**not** `meta.auth`-protected: the gateway signature is the authentication.
Returns `200 { received: true, ignored: true }` for an event the driver doesn't
map, and `200 { received: true, duplicate: true }` for one already processed.

### `Invoices` — `InvoicesOptions`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `InvoiceStore` | `MemoryInvoiceStore` | Durable invoices; also owns `nextNumber()`, which must allocate atomically |
| `numberPrefix` | `string` | `'INV'` | Human invoice number prefix — `INV-2026-0001` |
| `taxRate` | `number` | `0` | Applied to (subtotal − discount) when a draft omits `tax`. `0.14` = 14% |
| `now` | `() => number` | `Date.now` | Injectable clock (tests, backdating) |
| `idFactory` | `() => string` | `randomUUID` | Injectable id generator |

### `Coupons` — `CouponsOptions`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `CouponStore` | `MemoryCouponStore` | Durable coupon registry; `incrementRedemptions` must be atomic or `maxRedemptions` leaks |
| `now` | `() => number` | `Date.now` | Injectable clock, for `redeemBy` |

### `StripeBillingGateway(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `secretKey` | `string` | — (required) | Stripe secret API key |
| `webhookSecret` | `string` | — (required) | Endpoint signing secret (`whsec_…`). Verification fails closed without it |
| `priceId` | `(plan, period) => string` | — (required) | Maps a plan + period to a Stripe Price ID |
| `customerId` | `(billableId) => string \| Promise<string>` | — (required) | Resolves (or creates) the Stripe Customer for a billable |
| `resolveBillableId` | `(event) => string \| undefined` | reads `data.object.metadata.billableId` | Override when your events carry the id elsewhere |
| `tolerance` | `number` (seconds) | `300` | Webhook timestamp tolerance — replay window |
| `fetch` | `typeof fetch` | global `fetch` | Injected HTTP client (tests) |
| `now` | `() => number` | `Date.now` | Injectable clock in ms |
| `apiBase` | `string` | `https://api.stripe.com` | API base, for mocks |

### `PaddleBillingGateway(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (required) | Paddle API key (Bearer) |
| `webhookSecret` | `string` | — (required) | Notification signing secret; verifies the `Paddle-Signature` (`ts=…;h1=…`) scheme |
| `priceId` | `(plan, period) => string` | — (required) | Maps a plan + period to a Paddle Price ID (`pri_…`) |
| `customerId` | `(billableId) => string \| Promise<string>` | — (required) | Paddle Customer ID (`ctm_…`) |
| `resolveBillableId` | `(event) => string \| undefined` | reads `data.custom_data.billableId` | Override for events carrying the id elsewhere |
| `tolerance` | `number` (seconds) | `300` | Webhook timestamp tolerance |
| `fetch` / `now` / `apiBase` | — | global `fetch` / `Date.now` / `https://api.paddle.com` | Injection points for tests |

Paddle is checkout-first: both `createSubscription` and `createCheckoutSession`
create a **transaction**, and the durable subscription id arrives later on a
`subscription.*` webhook as `gatewayRef`.

### `LemonSqueezyBillingGateway(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (required) | Lemon Squeezy API key (Bearer) |
| `webhookSecret` | `string` | — (required) | Verifies the `X-Signature` header (HMAC-SHA256 hex over the raw body) |
| `storeId` | `string` | — (required) | Your store id — needed to create checkouts |
| `variantId` | `(plan, period) => string` | — (required) | Maps a plan + period to a Variant ID |
| `customerId` | `(billableId) => string \| Promise<string>` | — | **Required for the portal only**; omit it and `portal()` has nothing to open |
| `resolveBillableId` | `(event) => string \| undefined` | reads `meta.custom_data.billableId` | Override for events carrying the id elsewhere |
| `fetch` / `apiBase` | — | global `fetch` / `https://api.lemonsqueezy.com/v1` | Injection points for tests |

Lemon Squeezy is a merchant of record and checkout-first, with the same
"subscription id arrives by webhook" shape as Paddle. It has no timestamp
tolerance — the `X-Signature` scheme carries no timestamp.

### `ProxyPayGateway(options)` / `AppyPayGateway(options)`

These implement the reference-based `PaymentGateway` contract, not
`BillingGateway`. ProxyPay's options are tabled under **Construct the gateway**
above; AppyPay (`@basaltkit/subscriptions-appypay`, pre-release) adds OAuth2
(`clientId`, `clientSecret`, `tokenUrl`, `scope?`) and `defaultMethod`. The full
story is in [Reference & mobile-money payments](/guide/reference-payments).

### Durable store factories

| Factory | Package | Returns |
| --- | --- | --- |
| `sqliteSubscriptionsStores(dbOrLocation = ':memory:')` | `@basaltkit/subscriptions-sqlite` | `{ db, store, usage, webhooks }` — opens and migrates |
| `prismaSubscriptionsStores(client)` | `@basaltkit/subscriptions-prisma` | `{ store, usage, webhooks }` — throws immediately if the client has no `subscription` model |
| `sqlitePaymentStores(...)` / `prismaPaymentStores(client)` | same packages | The `PaymentStore` + `RecurringStore` for reference payments |
| `renderInvoicePdf(invoice, { locale?, businessName? })` | `@basaltkit/subscriptions-pdf` | `Promise<Buffer>` — keeps pdfkit out of the core |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `NotSubscribedError` | `BILLING_SUBSCRIPTION_REQUIRED` | 402 | `meta.subscribed` unmet; **or no tenant in context** on a billing/invoice route; or `swap`/`cancel`/`resume` with no active subscription |
| `FeatureUnavailableError` | `BILLING_FEATURE_UNAVAILABLE` | 403 | `meta.feature` not granted; or `consume()` on a feature whose limit is 0 (or with no plan and no `fallbackPlan`) |
| `QuotaExceededError` | `BILLING_QUOTA_EXCEEDED` | 402 | `consume()` would take usage past the limit — the store's atomic check refused |
| `GatewayUnsupportedError` | `BILLING_GATEWAY_UNSUPPORTED` | 501 | `checkout()` or `portal()` with no gateway, or one that doesn't implement that capability |
| `UnknownPlanError` | `BILLING_UNKNOWN_PLAN` | — | A plan name absent from the catalog — including a mistyped `fallbackPlan`, which throws at construction |
| `WebhookInvalidError` | `BILLING_WEBHOOK_INVALID` | 400 | Signature verification failed — almost always a parsed (re-serialized) body |
| `WebhookSecretMissingError` | `BILLING_WEBHOOK_SECRET_MISSING` | 500 | `verifyWebhook` with no signing secret configured. Fails closed: an unsigned callback is never trusted |
| `PaymentAmountMismatchError` | `BILLING_PAYMENT_AMOUNT_MISMATCH` | 400 | A confirmed payment's amount ≠ the amount requested for that payment id — underpayment or a forged callback |
| `StripeRequestError` · `PaddleRequestError` · `LemonSqueezyRequestError` | `BILLING_GATEWAY_ERROR` | — | The gateway's REST API returned a non-2xx; the original status is on `err.httpStatus` |
| `InvoiceNotFoundError` | `INVOICE_NOT_FOUND` | 404 | Unknown invoice id — **or** one belonging to another tenant, via `invoiceRoutes` |
| `InvoiceStateError` | `INVOICE_INVALID_STATE` | 409 | `finalize` a non-draft, `markPaid` a non-open, `void` a paid one, `addLine` to a finalized one — or `planLine()` on a `'custom'` price |
| `CouponInvalidError` | `COUPON_INVALID` | 422 | Bad shape: both/neither of `percentOff`/`amountOff`, percent outside 0–100, `amountOff` without a currency, `maxRedemptions < 1` |
| `CouponNotRedeemableError` | `COUPON_NOT_REDEEMABLE` | 422 | Expired (`redeemBy`), redemption cap reached, or the invoice currency differs from a fixed-amount coupon's |
| `CouponNotFoundError` | `COUPON_NOT_FOUND` | 404 | No coupon with that code |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | `billingRoutes()`/`invoiceRoutes()` registered with their default `auth: true` but no `authPlugin` |

- **A subscription that never becomes active** — work down this list, it is
  almost always one of three things. (1) You called `checkout()` and no webhook
  ever confirmed it, so the record is still `incomplete` — see
  [Two doors](#two-doors-into-a-subscription). (2) Your Prisma `Subscription`
  model is missing `pendingPlan` / `pendingPeriod`, so every write throws and
  nothing is ever stored. (3) The request carries no tenant, so the guard is
  asking about a billable that does not exist. Check which by reading the record
  directly: `await subscriptions.get(tenantId)` — `null` means nothing was ever
  written, `incomplete` means the webhook is missing.
- **`400 BILLING_WEBHOOK_INVALID` that won't go away** — the signature is
  computed over the untouched request bytes. Configure a raw-body parser for
  `/billing/webhook`; re-serializing a parsed object changes the bytes and breaks
  the HMAC.
- **Every request gets `402 BILLING_SUBSCRIPTION_REQUIRED`, even on the free
  plan** — the guard resolves the billable from `ctx().tenant.id`. No tenancy
  plugin, or no tenant identifier on the request, means no billable. Check
  tenancy first; then check that `fallbackPlan` is set.
- **A quota was overshot under load** — the in-memory `UsageStore` is
  per-process. Only the SQLite, Prisma and Redis stores do a real atomic
  check-and-increment (conditional `updateMany` / a single Lua `EVAL`).
- **A webhook was applied twice after a gateway retry** — the dedupe
  `WebhookStore` defaults to in-memory, so a retry landing on another replica
  looks fresh. Use `RedisWebhookStore` or the SQLite/Prisma one. (Within one
  process it is exact: a failed state write releases the claim so the retry can
  reprocess.)
- **A user of tenant A opened Checkout for tenant B** — `meta.auth` proves
  identity, not membership. Register
  [`tenantMembershipPlugin()`](/guide/teams).
- **`501 BILLING_GATEWAY_UNSUPPORTED` from `/billing/portal`** — the driver
  doesn't implement `createPortalSession` for your configuration; Lemon Squeezy,
  for instance, needs `customerId` to open one.
- **An abandoned Checkout changed nothing, as intended** — `checkout()` only
  records `pendingPlan`/`pendingPeriod`. The plan is promoted only when a
  `payment.succeeded` arrives with a **new** `gatewayRef`, so a renewal of the
  existing subscription can never escalate the plan.
- **Trials never expire** — gateway-backed trials are settled by the gateway's
  webhook and are deliberately ignored by `expireTrials()`. Local (gateway-less)
  trials need `expireTrials()` run from the [scheduler](/guide/scheduler).

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
