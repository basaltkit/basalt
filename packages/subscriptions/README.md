<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/subscriptions

Billing for the Basalt framework, in the style of Laravel Cashier/Soulbscription: declarative plans, subscriptions with a trial period, features with usage limits, Stripe / Paddle / Lemon Squeezy integration, and idempotent webhooks. You need this module when your SaaS application charges monthly fees and limits features by plan.

## What this module solves

In a typical SaaS you sell **plans** (e.g. Free, Pro, Enterprise): a plan is a package with a price and a set of **features** — things the customer can or can't do, and in what quantity (3 projects on Free, 50 on Pro; 1000 API calls per month). A **subscription** is the link between a customer and a plan, with a status (active, trialing, past due, canceled).

Implementing this by hand is treacherous: trial periods that expire, mid-month plan changes (with *proration* — the proportional adjustment of the amount), monthly limits that need to reset, and syncing with the payment processor (the *gateway*, e.g. Stripe), which communicates via **webhooks** — HTTP requests the gateway sends to your application when a payment succeeds or fails. Those webhooks arrive duplicated and out of order, and processing them twice corrupts the state.

This module gives you all of that ready to go: you define plans in code (`definePlans`), manage the lifecycle (`subscribe`, `checkout`, `swap`, `cancel`, `resume`), check and consume features (`features(...).can/consume`, with atomic quotas that are never exceeded even under concurrent requests), and process webhooks **idempotently** (each event is applied exactly once, even if it arrives ten times). The local state is the "source of read truth": checking a feature never makes calls to Stripe.

## Installation

```bash
pnpm add @basaltkit/subscriptions
```

The package depends on `@basaltkit/core` and `@basaltkit/http` — **not** on any single adapter. The routes it ships are built with the neutral `route()`, so they serve identically on `@basaltkit/fastify`, `@basaltkit/express` and `@basaltkit/hono`. `zod` is a *peer dependency*.

Durable stores live in companion packages: [`@basaltkit/subscriptions-sqlite`](../subscriptions-sqlite/README.md) (single node, `node:sqlite`) and [`@basaltkit/subscriptions-prisma`](../subscriptions-prisma/README.md) (PostgreSQL/MySQL).

## Get started in 5 minutes

1. **Define the plans.** `price: 0` is free; an object gives monthly/yearly prices; `'custom'` is "talk to us". Features can be: boolean (on/off), number (lifetime balance), `meter(n)` (quota that resets every month), or `Infinity` (unlimited):

```ts
// src/billing/plans.ts
import { definePlans, meter } from '@basaltkit/subscriptions'

export const plans = definePlans({
  free: { price: 0, features: { projects: 3, api: false } },
  pro: {
    // Prices are INTEGERS IN MINOR UNITS — 2900 is $29.00, not $2900.
    price: { monthly: 2_900, yearly: 29_000 },
    trial: '14d', // 14-day trial period
    features: { projects: 50, api: true, 'api.requests': meter(1000) },
  },
  scale: { price: 'custom', features: { projects: Number.POSITIVE_INFINITY, api: true } },
})
```

> **Every amount in this package's public API is an integer in the currency's minor unit** —
> `100` = 1.00, the Stripe/Adyen convention. It removes floating-point rounding and any
> ambiguity about units. A plan's `price` is only used for gating (`> 0` → paid) and
> display; the amount actually charged comes from the pre-created price id at the gateway.
> Use the [money helpers](#money) to convert at the human boundary — and note that
> `assertMinorUnits` makes a major-unit slip (`29.99` instead of `2999`) fail fast rather
> than silently undercharge by a factor of 100.

2. **Create the service** (no gateway yet — everything works locally):

```ts
// src/billing/subscriptions.ts
import { Subscriptions } from '@basaltkit/subscriptions'
import { plans } from './plans.js'

export const subscriptions = new Subscriptions({
  plans,
  fallbackPlan: 'free', // plan applied to those without a subscription
})
```

3. **Subscribe a customer.** `billableId` is the identifier of who pays — by convention, the tenant's id:

```ts
const record = await subscriptions.subscribe('acme', 'pro')
console.log(record.status)                       // 'trialing' (the plan has a trial)
console.log(await subscriptions.subscribed('acme')) // true
console.log(await subscriptions.onTrial('acme'))    // true
```

4. **Check and consume features:**

```ts
const features = subscriptions.features('acme')

console.log(await features.can('api'))            // true
console.log(await features.remaining('projects')) // 50

await features.consume('projects', 2)             // records the creation of 2 projects
console.log(await features.remaining('projects')) // 48
```

5. When the limit runs out, `consume` throws `QuotaExceededError`; a feature that's off in the plan throws `FeatureUnavailableError`. Just catch these errors to show an "upgrade" prompt.

## Usage guide

### Defining plans

Each plan (`PlanDefinition`) has:

| Field | Type | Required? | Description |
|---|---|---|---|
| `price` | `number \| { monthly, yearly } \| 'custom'` | Yes | `0` = free; a number = same price in both periods; `'custom'` = sales |
| `trial` | `DurationInput` (e.g. `'14d'`) | No | Trial period duration |
| `features` | `Record<string, FeatureValue>` | Yes | `boolean` (flag) · `number` (lifetime balance) · `meter(n)` (monthly quota) · `Infinity` (unlimited) |

`meter(n)` counters reset every calendar month (bucket `YYYY-MM`); numeric balances are lifetime.

### Subscribing

```ts
await subscriptions.subscribe('acme', 'pro')                        // monthly (default)
await subscriptions.subscribe('acme', 'pro', { period: 'yearly' })  // yearly
```

- A plan with `trial` → `trialing` status until the trial period ends.
- With a gateway configured, **paid** plans are also created in the gateway (with the trial in days, if any); free plans never touch the gateway.
- Recommended alternative in production: **Checkout** (the customer enters their card on a page hosted by the gateway):

```ts
const { url } = await subscriptions.checkout('acme', 'pro', {
  successUrl: 'https://app.example.com/thank-you',
  cancelUrl: 'https://app.example.com/pricing',
})
// redirect the customer to `url`; the subscription becomes 'incomplete'
// and switches to 'active' when the payment.succeeded webhook arrives
```

**A checkout never overwrites a live subscription.** When one already exists, the intent is
recorded as `pendingPlan` / `pendingPeriod` instead of mutating `plan`/`status`/`gatewayRef`.
`handleWebhook` promotes it only when the gateway confirms payment with a **new** gateway
ref — so an abandoned checkout can't escalate the plan on the next legitimately-signed
renewal webhook. If you implement `SubscriptionStore` yourself, persist `pendingPlan` and
`pendingPeriod`, and make sure clearing them (writing `null`) round-trips.

### Changing plans (swap)

```ts
await subscriptions.swap('acme', 'scale')                    // with proration (immediate adjustment)
await subscriptions.swap('acme', 'scale', { prorate: false }) // only changes at the next renewal
```

Requires an active subscription (otherwise `NotSubscribedError`). If the subscription is linked to the gateway, the change is pushed there with the chosen proration behavior.

### Canceling and resuming

```ts
await subscriptions.cancel('acme')                        // at the end of the period (default) — stays active until then
await subscriptions.resume('acme')                        // change your mind before the end: undoes the cancellation
await subscriptions.cancel('acme', { atPeriodEnd: false }) // immediate: status 'canceled' right away
```

### Customer portal (self-service)

```ts
const { url } = await subscriptions.portal('acme', { returnUrl: 'https://app.example.com/account' })
// redirect to `url` — the customer updates their card, changes plan, or cancels on their own
```

### Features: the `features(billableId)` API

| Method | Returns | Description |
|---|---|---|
| `can(feature)` | `Promise<boolean>` | Does the plan grant access (limit > 0)? |
| `limit(feature)` | `Promise<number>` | Normalized limit (`false`→0, `true`→`Infinity`) |
| `usage(feature)` | `Promise<number>` | Consumption in the current period |
| `remaining(feature)` | `Promise<number>` | How much is still left to consume |
| `consume(feature, amount = 1)` | `Promise<number>` | Records consumption atomically; throws `QuotaExceededError` if exceeded, `FeatureUnavailableError` if there's no access |

Anyone without an active subscription uses the `fallbackPlan` (if defined); without a fallback, they have no access to anything.

### Trial periods

- **Local** trials (no gateway): run `expireTrials()` periodically (e.g. from the scheduler). Free plan → `active`; paid plan → `past_due`.
- **Gateway-managed** trials: the gateway charges at the end of the trial and the webhook makes the transition (`payment.succeeded` → `active`, `payment.failed` → `past_due`). `expireTrials()` deliberately ignores them.

### Stripe gateway

The driver talks directly to the Stripe REST API (no SDK). You need to tell it how to map your plans to Stripe *Price IDs* and how to get the *Customer ID* for each billable:

```ts
import { StripeBillingGateway, Subscriptions } from '@basaltkit/subscriptions'
import { plans } from './plans.js'

const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_...
  priceId: (plan, period) => ({
    pro: { monthly: 'price_pro_m', yearly: 'price_pro_y' },
  })[plan]![period],
  customerId: async (billableId) => getOrCreateStripeCustomer(billableId),
})

export const subscriptions = new Subscriptions({ plans, gateway, fallbackPlan: 'free' })
```

### Paddle gateway

`PaddleBillingGateway` targets **Paddle Billing** the same way (no SDK, injectable `fetch`), mapping plans to Paddle *Price IDs* (`pri_…`) and billables to *Customer IDs* (`ctm_…`). Paddle is checkout-first, so `createSubscription`/`createCheckoutSession` create a transaction and the durable subscription ref arrives on a `subscription.*` webhook.

```ts
import { PaddleBillingGateway, Subscriptions } from '@basaltkit/subscriptions'

const gateway = new PaddleBillingGateway({
  apiKey: process.env.PADDLE_API_KEY!,
  webhookSecret: process.env.PADDLE_NOTIFICATION_SECRET!, // ntfset_...
  priceId: (plan, period) => ({ pro: { monthly: 'pri_pro_m', yearly: 'pri_pro_y' } })[plan]![period],
  customerId: async (billableId) => getOrCreatePaddleCustomer(billableId),
})
```

Webhook signatures use Paddle's `Paddle-Signature` scheme (`ts=…;h1=…`, HMAC-SHA256 over `${ts}:${rawBody}`) — verified by the driver, with the same 5-minute timestamp tolerance as Stripe.

### Lemon Squeezy gateway

`LemonSqueezyBillingGateway` targets the Lemon Squeezy REST API (JSON:API, no SDK), mapping plans to *Variant IDs* and using your *Store ID* for checkouts. Also checkout-first; webhook signatures use the `X-Signature` header (a bare HMAC-SHA256 hex of the raw body — no timestamp).

```ts
import { LemonSqueezyBillingGateway, Subscriptions } from '@basaltkit/subscriptions'

const gateway = new LemonSqueezyBillingGateway({
  apiKey: process.env.LEMONSQUEEZY_API_KEY!,
  webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET!,
  storeId: process.env.LEMONSQUEEZY_STORE_ID!,
  variantId: (plan, period) => ({ pro: { monthly: '111', yearly: '222' } })[plan]![period],
  customerId: async (billableId) => getLemonSqueezyCustomer(billableId), // for the portal
})
```

For development and testing there's `FakeBillingGateway`, which records all calls in arrays (`created`, `canceled`, `checkouts`, `portals`, `swaps`) and accepts the webhook signature `'valid'`.

### Gateway webhooks

`handleWebhook(event)` applies a `WebhookEvent` already translated into domain terms: `subscription.canceled` → `canceled`, `payment.failed` → `past_due`, `payment.succeeded` → `active`. Processing is idempotent by `event.id` (returns `false` for duplicates), and if saving the state fails, the id is released so the gateway's retry can reprocess it.

Over HTTP, use the ready-made route (next section) — signature verification is handled by the gateway driver.

### HTTP integration (plugin, guards, and routes)

`subscriptionsPlugin` registers two services in the container — `SUBSCRIPTIONS` and
`INVOICES` — and adds a route **guard**: with `meta: { subscribed: true | 'plan' }` the
route requires an active subscription (otherwise HTTP 402); with `meta: { feature: 'api' }`
it requires the feature (otherwise HTTP 403). The billable is the tenant from the request
context, so a tenancy plugin must run first (its enricher sets `context.tenant`).

Everything here is adapter-neutral: the routes come from `@basaltkit/http`'s `route()`, and
the guard is registered in the framework-neutral `'http:guards'` bucket. Swap
`fastifyPlugin` for `expressPlugin` or `honoPlugin` and nothing else changes.

```ts
import { createApp } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { fastifyPlugin } from '@basaltkit/fastify' // or expressPlugin / honoPlugin
import {
  billingRoutes,
  billingWebhookRoute,
  invoiceRoutes,
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
        route({
          method: 'GET',
          url: '/reports',
          meta: { subscribed: 'pro' },   // requires the "pro" plan
          async handler() { return { ok: true } },
        }),
        route({
          method: 'GET',
          url: '/api-data',
          meta: { feature: 'api' },      // requires the "api" feature
          async handler() { return { data: [] } },
        }),
        ...billingRoutes({
          successUrl: 'https://app.example.com/thank-you',
          cancelUrl: 'https://app.example.com/pricing',
        }),
        ...invoiceRoutes(),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

Routes created:

| Route | Body / params | Returns | `meta.auth` |
|---|---|---|---|
| `POST /billing/checkout` | `{ plan, period?, successUrl?, cancelUrl? }` | `{ url }` to redirect to | **yes** by default |
| `POST /billing/portal` | `{ returnUrl? }` (optional) | `{ url }` | **yes** by default |
| `GET /billing/invoices` | — | `{ data: Invoice[] }`, newest first | **yes** by default |
| `GET /billing/invoices/:id` | `:id` | one `Invoice` as JSON | **yes** by default |
| `GET /billing/invoices/:id/html` | `:id` | a printable HTML invoice | **yes** by default |
| `POST /billing/webhook` | raw gateway payload | `200 { received, duplicate }` (or `{ received, ignored }`) | no — the signature *is* the authentication |

**Secure by default.** `billingRoutes()` and `invoiceRoutes()` both stamp
`meta: { auth: true }` on every route they create: these mint live payment-management URLs
and expose a tenant's payment history, so they must never be anonymous. Pass
`{ auth: false }` **only** when authentication genuinely happens at an outer edge — a
deliberate, documented opt-out.

Because they declare `meta.auth`, these routes participate in the adapters' boot-time
guarded-meta check: if `@basaltkit/auth`'s `authPlugin` isn't registered, the app refuses to
boot with `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) rather than serving your
billing endpoints open.

Invoice ownership is enforced against the current tenant: another tenant's invoice reads
as `404 INVOICE_NOT_FOUND`, never `403` (which would confirm the id exists). Issuing and
finalizing invoices stays server-side, through the `INVOICES` token.

Important: Stripe (and Paddle) verify the signature over the request's **raw body** — any
re-serialization changes bytes and breaks the HMAC. Configure a raw-body parser for the
webhook route so `request.body` arrives as a string. The route reads the signature from
`stripe-signature`, falling back to `x-billing-signature`. A verified-but-irrelevant event
returns `{ received: true, ignored: true }`; a duplicate returns `duplicate: true`.

### Invoices

`Invoices` is a self-contained invoice engine: draft → finalize → paid/void, with totals
recomputed from line items on every edit. It is registered under the `INVOICES` token by
`subscriptionsPlugin` (configure it with the plugin's `invoices` option).

```ts
import { INVOICES, planLine, overageLine } from '@basaltkit/subscriptions'

const invoices = app.container.get(INVOICES)

const draft = await invoices.draft({
  billableId: 'acme',
  currency: 'USD',
  lineItems: [
    planLine('Pro (monthly)', 2_900),
    overageLine('API requests', { units: 1_200, unitAmount: 2 }),
  ],
})
await invoices.finalize(draft.id)          // assigns the number, freezes the totals
await invoices.markPaid(draft.id)
```

| Member | Signature | Description |
|---|---|---|
| `draft` | `(DraftInvoiceInput) => Promise<Invoice>` | Creates a `draft` invoice and computes subtotal/discount/tax/total. |
| `addLine` | `(id, NewLineItem) => Promise<Invoice>` | Adds a line and recomputes. Draft only. |
| `finalize` | `(id) => Promise<Invoice>` | Assigns the sequential number and moves to `open`. Draft only. |
| `markPaid` | `(id, settlement?) => Promise<Invoice>` | `open` → `paid`; records `paymentId`/`gatewayRef`/`paidAt` and zeroes `amountDue`. |
| `void` | `(id) => Promise<Invoice>` | Voids a `draft` or `open` invoice. A **paid** one cannot be voided — refund instead. |
| `get` · `list` | `(id)` · `(billableId)` | Read one, or a billable's invoices. |

An action in the wrong state throws `InvoiceStateError` (`INVOICE_INVALID_STATE`, 409); an
unknown id throws `InvoiceNotFoundError` (`INVOICE_NOT_FOUND`, 404). `renderInvoiceText`
and `renderInvoiceHtml` produce printable output (the HTML one backs
`GET /billing/invoices/:id/html`).

`InvoicesOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `store` | `InvoiceStore` | `MemoryInvoiceStore` | Persistence. The in-memory one forgets on restart — invoices are legal records, so back it with a database. |
| `numberPrefix` | `string` | `'INV'` | Invoice-number prefix; numbering is sequential per year. |
| `taxRate` | `number` | `0` | Applied when a draft omits `tax`. `0.14` = 14%. |
| `now` · `idFactory` | `() => number` · `() => string` | `Date.now` · random | Injection points for deterministic tests. |

### Coupons

`Coupons` validates, stores and prices discount codes. `couponDiscount()` is pure — use it
to quote a discount before applying it to an invoice.

| Option (`CouponsOptions`) | Type | Default | Purpose |
|---|---|---|---|
| `store` | `CouponStore` | `MemoryCouponStore` | Persistence (`save`/`get`/`all`/`incrementRedemptions`). |
| `now` | `() => number` | `Date.now` | Clock injection, for expiry tests. |

A `Coupon` is `{ code, percentOff? | amountOff?, currency?, duration?, maxRedemptions?, redeemBy?, metadata? }`.
Rules enforced by `assertValidCoupon` (each throws `CouponInvalidError`, `COUPON_INVALID`, 422):
exactly one of `percentOff`/`amountOff`; `percentOff` within 0–100; `amountOff` a
non-negative minor-unit integer **and** accompanied by a `currency`; `maxRedemptions ≥ 1`.
A fixed-amount coupon in a different currency yields a discount of `0` rather than
silently converting. Discounts are always clamped to `[0, subtotal]`.

### Reference-based recurring billing (payments, not cards)

Some markets bill by **payment reference** rather than a stored card: you issue a reference
per period and the customer pays it at a bank/ATM/app. `PaymentGateway` +
`PaymentLedger` + `RecurringReferenceBilling` cover that flow (this is what the ProxyPay
and AppyPay drivers plug into).

```ts
import { PaymentLedger, RecurringReferenceBilling } from '@basaltkit/subscriptions'

const ledger = new PaymentLedger({ store, webhooks })
const billing = new RecurringReferenceBilling({ gateway, ledger, store: recurringStore })

await billing.subscribe({ billableId: 'acme', plan: 'pro', amount: 500_000, interval: 'monthly' })
const due = await billing.due()                    // within leadDays of period end
await billing.issueNext('acme')                    // mint the next reference
await billing.handleEvent(verifiedPaymentEvent)    // idempotent; extends paidThrough
```

`PaymentLedger` ties payment records to webhook idempotency: `created()` records a pending
payment, `apply(event)` dedupes by `event.id` and returns `{ fresh, record }`. It emits
`recorded`, `confirmed` and `failed` via `ledger.on(...)`; a listener that throws is
reported to `onListenerError` (default: swallowed) and never rolls back a payment.

| Option (`RecurringBillingOptions`) | Type | Default | Purpose |
|---|---|---|---|
| `gateway` | `PaymentGateway` | — (required) | The payment driver. |
| `ledger` | `PaymentLedger` | in-memory | Payment records + webhook idempotency. |
| `store` | `RecurringStore` | `MemoryRecurringStore` | Where recurring subscriptions live. |
| `leadDays` | `number` | `5` | How many days before period end a subscription becomes `due()` — your window to issue and deliver the next reference. |
| `currency` | `string` | the gateway's own | ISO 4217 currency passed to the gateway. |

| Option (`PaymentLedgerOptions`) | Type | Default | Purpose |
|---|---|---|---|
| `store` | `PaymentStore` | `MemoryPaymentStore` | Where payment records live. |
| `webhooks` | `WebhookStore` | `MemoryWebhookStore` | Dedupe store. **Share one durable store app-wide** so a retried callback is applied exactly once. |
| `onListenerError` | `(error, event) => void` | swallow | Surfaces a throwing lifecycle listener instead of losing it. |

A confirmed payment whose amount doesn't match what was requested raises
`PaymentAmountMismatchError` (`BILLING_PAYMENT_AMOUNT_MISMATCH`, 400) — an underpayment or
a forged callback must never settle an invoice for less.

### Money

All amounts are minor units. These helpers live at the human boundary:

| Export | Signature | Purpose |
|---|---|---|
| `toMinor` | `(major, currency) => number` | `toMinor(5000, 'AOA')` → `500000`. Use on form input. |
| `toMajor` | `(minor, currency) => number` | The inverse, for display maths. |
| `formatMoney` | `(minor, currency, locale?) => string` | Localized display (`locale` defaults to `'en-US'`); falls back to a plain string when `Intl` lacks the currency. |
| `currencyDecimals` | `(currency) => number` | Minor-unit exponent (0 for JPY/XOF/XAF/CLP, else 2). |
| `isMinorUnits` | `(amount) => boolean` | Non-negative integer? |
| `assertMinorUnits` | `(amount, label?) => void` | Throws a `RangeError` otherwise. Drivers call it so a major-unit slip fails fast. |

### Metered pricing tiers

`tieredCost(price, units)` prices consumed units through brackets, `'graduated'` (each unit
priced by the bracket it falls into, like tax brackets) or `'volume'` (all units priced at
the single bracket the total lands in). `meteredLine(...)` turns recorded usage into an
invoice line. A `PricingTier` is `{ upTo: number | null, unitAmount, flatAmount? }`, ordered
ascending, with the last tier `upTo: null` (unbounded).

### Plans in a database — `PlanStore`

Plans are consumed as a **synchronous** `Plans` object (by `planPrice`, feature checks and
the guards), so a durable catalog is loaded **once at boot** — edit a plan in the store,
restart to apply.

```ts
import { loadPlans, MemoryPlanStore, plansToStored, subscriptionsPlugin } from '@basaltkit/subscriptions'

const planStore = new MemoryPlanStore(plans)     // or a DB-backed PlanStore
const catalog = await loadPlans(planStore)       // at boot
subscriptionsPlugin({ plans: catalog, fallbackPlan: 'free' })
```

`PlanStore` is `all()` / `get(name)` / `save(plan)` over `StoredPlan` = `{ name, definition }`.
`plansToStored(plans)` turns a `definePlans({...})` object into rows, for seeding.

### Production: Redis stores

In-memory stores are per-process. In production:

```ts
import { Redis } from 'ioredis'
import { RedisUsageStore, RedisWebhookStore, Subscriptions } from '@basaltkit/subscriptions'
import { plans } from './plans.js'

const redis = new Redis(process.env.REDIS_URL!)

export const subscriptions = new Subscriptions({
  plans,
  usage: new RedisUsageStore(redis),      // atomic quotas via a Lua script (EVAL)
  webhooks: new RedisWebhookStore(redis), // durable dedupe via SET NX EX
  // store: implement SubscriptionStore over your database
})
```

`SubscriptionStore` (the subscriptions themselves) should live in your database — implement `get/save/all`.

### Domain hooks

The service emits these on Basalt's `HookBus` (the plugin passes the bus in for you):

| Hook | Payload | Emitted when |
|---|---|---|
| `billing:subscribed` | `{ subscription }` | `subscribe()` persisted a new subscription. |
| `billing:checkout_started` | `{ billableId, plan, url }` | `checkout()` created a hosted session. |
| `billing:swapped` | `{ subscription, from }` | `swap()` changed the plan; `from` is the previous one. |
| `billing:canceled` | `{ subscription }` | `cancel()` ran — both at-period-end and immediate. |
| `billing:trial_expired` | `{ subscription }` | `expireTrials()` settled a **local** trial. |
| `billing:webhook` | `{ event }` | A gateway event was applied (fresh, not a duplicate). |

Hook handlers are isolated by `HookBus`: one throwing never starves the others, and the
failure surfaces to the emitter afterwards. Use them to send emails/notifications:

```ts
app.hooks.on('billing:trial_expired', ({ subscription }) => {
  // e.g.: notifier.notify(...) or mailer.send(...)
})
```

## API reference

### Plans

| Export | Signature | Description |
|---|---|---|
| `definePlans` | `<T extends Plans>(plans: T) => T` | Declares the plan catalog (preserves types) |
| `meter` | `(limit: number) => Meter` | Metered feature with a monthly reset |
| `planPrice` | `(plan, period) => number \| 'custom'` | A plan's price for a period |
| `featureLimit` | `(value?) => number` | Normalized limit (`false`→0, `true`→`Infinity`) |
| `isMeter` | `(value?) => value is Meter` | (Advanced) tests whether a value is a meter |
| `UnknownPlanError` | error | `BILLING_UNKNOWN_PLAN` — undefined plan |

### `class Subscriptions`

`new Subscriptions(options: SubscriptionsOptions)`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `plans` | `Plans` | Yes | — | Plan catalog |
| `store` | `SubscriptionStore` | No | `MemorySubscriptionStore` | Subscription persistence |
| `usage` | `UsageStore` | No | `MemoryUsageStore` | Consumption counters |
| `gateway` | `BillingGateway` | No | — | Payment processor |
| `webhooks` | `WebhookStore` | No | `MemoryWebhookStore` | Webhook dedupe (Redis in production) |
| `fallbackPlan` | `string` | No | — | Plan for those without a subscription (validated at startup) |
| `hooks` | `HookBus` | No | — | Hook bus (the plugin passes it automatically) |

Methods:

| Method | Signature | Description |
|---|---|---|
| `plan` | `(name) => PlanDefinition` | Gets a plan; throws `UnknownPlanError` |
| `subscribe` | `(billableId, plan, { period? }?) => Promise<SubscriptionRecord>` | Creates the subscription (gateway only for paid plans) |
| `checkout` | `(billableId, plan, { period?, successUrl, cancelUrl }) => Promise<{ url }>` | Hosted Checkout session; saves `incomplete` state |
| `portal` | `(billableId, { returnUrl }) => Promise<{ url }>` | Customer Portal session |
| `get` | `(billableId) => Promise<SubscriptionRecord \| null>` | Reads the subscription |
| `subscribed` | `(billableId, plan?) => Promise<boolean>` | Active (or in a valid trial), optionally on a specific plan |
| `onTrial` | `(billableId) => Promise<boolean>` | Is it in a trial period? |
| `swap` | `(billableId, plan, { prorate? }?) => Promise<SubscriptionRecord>` | Changes plan (proration by default) |
| `cancel` | `(billableId, { atPeriodEnd? }?) => Promise<SubscriptionRecord>` | Cancels (at the end of the period by default) |
| `resume` | `(billableId) => Promise<SubscriptionRecord>` | Undoes a scheduled cancellation |
| `features` | `(billableId) => { can, limit, usage, remaining, consume }` | Features API (see above) |
| `handleWebhook` | `(event: WebhookEvent) => Promise<boolean>` | Applies an event idempotently; `false` = duplicate |
| `expireTrials` | `() => Promise<SubscriptionRecord[]>` | Settles expired local trials (run it in the scheduler) |

`SubscriptionRecord`: `{ billableId, plan, period, status, trialEndsAt?, cancelAtPeriodEnd?, canceledAt?, gatewayRef? }` with `status ∈ 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete'`.

### Errors

Every one extends `BasaltError`, so `error.code` is stable; those with a numeric `status`
are mapped straight to that HTTP status by the adapters.

| Error | Code | HTTP | When |
|---|---|---|---|
| `NotSubscribedError` | `BILLING_SUBSCRIPTION_REQUIRED` | 402 | A `meta.subscribed` route was hit without an active subscription — or with no tenant in the context at all. Also thrown by `swap`/`cancel`/`resume` on a missing or inactive subscription. |
| `FeatureUnavailableError` | `BILLING_FEATURE_UNAVAILABLE` | 403 | A `meta.feature` route, or `features().consume()`, for a feature whose plan limit is `0`/absent. |
| `QuotaExceededError` | `BILLING_QUOTA_EXCEEDED` | 402 | `features().consume()` would exceed the limit for the current period. |
| `GatewayUnsupportedError` | `BILLING_GATEWAY_UNSUPPORTED` | 501 | `checkout()`/`portal()` with no gateway configured, or a driver that doesn't implement that capability. |
| `UnknownPlanError` | `BILLING_UNKNOWN_PLAN` | — | A plan name isn't in `definePlans()`. Also thrown **at construction** for a bad `fallbackPlan`, so typos fail at boot. |
| `WebhookInvalidError` | `BILLING_WEBHOOK_INVALID` | 400 | Signature verification failed. Almost always a re-serialized body or the wrong secret. |
| `WebhookSecretMissingError` | `BILLING_WEBHOOK_SECRET_MISSING` | 500 | A gateway was asked to verify a webhook with no signing secret configured. Verification fails **closed** — an unsigned callback is never trusted. |
| `PaymentAmountMismatchError` | `BILLING_PAYMENT_AMOUNT_MISMATCH` | 400 | A confirmed payment's amount ≠ the amount requested for that payment id. |
| `InvoiceNotFoundError` | `INVOICE_NOT_FOUND` | 404 | Unknown invoice id — also what another tenant's invoice looks like. |
| `InvoiceStateError` | `INVOICE_INVALID_STATE` | 409 | An invoice action illegal in the current status (e.g. finalizing a finalized invoice). |
| `CouponInvalidError` | `COUPON_INVALID` | 422 | The coupon's shape is invalid (see the coupon rules above). |
| `CouponNotRedeemableError` | `COUPON_NOT_REDEEMABLE` | 422 | Expired, or over `maxRedemptions`. |
| `CouponNotFoundError` | `COUPON_NOT_FOUND` | 404 | Unknown coupon code. |
| `StripeRequestError` · `PaddleRequestError` · `LemonSqueezyRequestError` | `BILLING_GATEWAY_ERROR` | — (carries `httpStatus`) | The gateway's REST API returned an error. |
| `RangeError` | — | — | `assertMinorUnits` caught a non-integer or negative amount. Not a `BasaltError` — it is a programming mistake, not a domain outcome. |

### Gateways

`BillingGateway` (Advanced — the contract for writing a gateway driver): `name`, `createSubscription`, `cancelSubscription`, `verifyWebhook`, and, optionally, `createCheckoutSession`, `createPortalSession`, `swapSubscription`. `verifyWebhook(rawBody, signature)` validates the signature (throws `WebhookInvalidError`, `BILLING_WEBHOOK_INVALID`, 400) and translates the payload into a `WebhookEvent` — `{ id, type, billableId, gatewayRef? }` with `type ∈ 'subscription.canceled' | 'payment.failed' | 'payment.succeeded'` — or `null` for events that are verified but irrelevant.

`StripeGatewayOptions`:

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `secretKey` | `string` | Yes | — | Stripe API secret key |
| `webhookSecret` | `string` | Yes | — | Endpoint secret (`whsec_...`) |
| `priceId` | `(plan, period) => string` | Yes | — | Maps plan+period → Stripe Price ID |
| `customerId` | `(billableId) => string \| Promise<string>` | Yes | — | Gets/ensures the Stripe Customer ID |
| `resolveBillableId` | `(event) => string \| undefined` | No | reads `metadata.billableId` | (Advanced) extracts the billable from an event |
| `tolerance` | `number` | No | `300` | Webhook timestamp tolerance (seconds) |
| `fetch` / `now` / `apiBase` | — | No | globals | (Advanced) injections for tests |

Specific error: `StripeRequestError` (`BILLING_GATEWAY_ERROR`, with `httpStatus`).

`FakeBillingGateway` — a test/development gateway; records calls in `created`, `canceled`, `checkouts`, `portals`, `swaps`, and only accepts the `'valid'` signature in `verifyWebhook`.

### Stores

| Export | Description |
|---|---|
| `SubscriptionStore` (Advanced) | `get/save/all` — implement over your DB; `MemorySubscriptionStore` included |
| `UsageStore` (Advanced) | `get/increment/consume` — `consume` must be atomic; `MemoryUsageStore` included |
| `WebhookStore` (Advanced) | `markProcessed(id)` (claim; `true` = new) / `release(id)`; `MemoryWebhookStore` included |
| `RedisUsageStore` | `new RedisUsageStore(redis, { prefix? = 'basalt:usage', ttlSeconds? = 60 days })` — atomic quotas via EVAL |
| `RedisWebhookStore` | `new RedisWebhookStore(redis, { prefix? = 'basalt:webhook', ttlSeconds? = 7 days })` — durable dedupe via SET NX EX |
| `RedisLike` / `RedisWebhookClient` | (Advanced) minimal surfaces compatible with ioredis — inject your own client |

### Plugin and HTTP routes

| Export | Description |
|---|---|
| `SUBSCRIPTIONS` | `Token<Subscriptions>` — the billing service |
| `INVOICES` | `Token<Invoices>` — the invoice engine |
| `subscriptionsPlugin(options)` | Registers both services and the `meta.subscribed`/`meta.feature` guard |
| `billingRoutes(options)` | `POST /billing/checkout` + `POST /billing/portal` for the current tenant |
| `invoiceRoutes(options?)` | `GET /billing/invoices`, `/:id`, `/:id/html` for the current tenant |
| `billingWebhookRoute(gateway)` | `POST /billing/webhook` — signature verified by the driver, idempotent processing |

`SubscriptionsPluginOptions` = `SubscriptionsOptions` **without** `hooks` (the plugin supplies the app's `HookBus`), plus:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `invoices` | `InvoicesOptions` | `{}` → `MemoryInvoiceStore` | Config for the `Invoices` instance bound to `INVOICES`. |

`BillingRoutesOptions`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `successUrl` | `string` | — (required) | Where the gateway returns the customer after a successful Checkout. The request body may override it per call. |
| `cancelUrl` | `string` | — (required) | Where the gateway returns them on abandonment. |
| `portalReturnUrl` | `string` | `successUrl` | Where the Customer Portal returns them. |
| `auth` | `boolean` | `true` | Stamps `meta: { auth: true }` on both routes. Set `false` **only** when an outer edge authenticates — these routes mint live payment-management URLs for the current tenant. |

`invoiceRoutes({ auth? })` takes the same `auth` option, with the same `true` default and the same warning: invoices are a tenant's payment history.

## Common errors and solutions (FAQ)

**HTTP 402 `BILLING_SUBSCRIPTION_REQUIRED` on a guarded route** — The request's tenant doesn't have an active subscription (or there's no tenant in the context). Check the tenancy plugin and whether the customer has subscribed.

**Unexpected `QuotaExceededError`** — The plan's limit ran out for the current period. Remember: `meter(n)` resets by calendar month; a plain `number` is a lifetime balance that never resets.

**The Stripe webhook always returns 400 `BILLING_WEBHOOK_INVALID`** — It's almost always the raw body: Stripe signs the exact bytes, and any re-serialization breaks the HMAC. Configure raw body on the webhook route and confirm the `webhookSecret`. Also check clock skew (5-minute tolerance).

**After Checkout, the subscription stays `incomplete` forever** — The `payment.succeeded` webhook never arrived. Confirm the `/billing/webhook` endpoint is reachable by Stripe and that the `invoice.paid`/`invoice.payment_succeeded` events are enabled on the Stripe endpoint.

**`GatewayUnsupportedError` when calling `checkout`/`portal`** — You didn't configure `gateway`, or the driver doesn't implement that capability. Pass a `StripeBillingGateway` (or `FakeBillingGateway` in dev).

**Paid trials never move to `active`** — Gateway-backed trials are converted by the gateway's webhook, not by `expireTrials()`. Without a gateway, you really do need to run `expireTrials()` in a scheduler (and a local paid-plan trial ends up in `past_due`, because there's no way to charge).

**Quotas exceeded under concurrent traffic in production** — You're running `MemoryUsageStore` across multiple processes: each process has its own counter. Use `RedisUsageStore`, whose Lua script guarantees an atomic check-and-increment across instances.

## How it connects to other modules

- **@basaltkit/core** — `createApp`, the container (token `SUBSCRIPTIONS`), the request context (where the tenant/billable comes from), and `HookBus` (`billing:*` hooks).
- **@basaltkit/http** — `route()`, and the neutral `'http:guards'` bucket the `meta.subscribed`/`meta.feature` guard registers into. The routes therefore run identically on **@basaltkit/fastify**, **@basaltkit/express** and **@basaltkit/hono** — nothing here is adapter-specific.
- **@basaltkit/auth** — enforces the `meta.auth` that `billingRoutes`/`invoiceRoutes` declare. Without `authPlugin` registered, the adapter refuses to boot (`HTTP_UNGUARDED_ROUTE_META`).
- **@basaltkit/tenancy** — its enricher sets `context.tenant`, which is where the `billableId` comes from.
- **@basaltkit/subscriptions-sqlite / -prisma** — durable `SubscriptionStore`, `UsageStore`, `WebhookStore`, `PaymentStore` and `RecurringStore` implementations.
- **@basaltkit/mailer** and **@basaltkit/notifications** — subscribe to the `billing:*` hooks to send emails/notifications ("your trial has expired", "payment failed").
- **@basaltkit/webhooks** — the opposite direction: this module *receives* webhooks from the gateway; `@basaltkit/webhooks` *sends* webhooks to your customers (you can forward `billing:*` events there).
- **@basaltkit/scheduler** — the natural place to run `expireTrials()` periodically.
- **@basaltkit/queue** — asynchronous processing of reactions to billing hooks.

Guides: [Billing](/guide/billing) · [Payment references](/guide/reference-payments) · [Tenancy](/guide/tenancy) · [Persistence](/guide/persistence)
