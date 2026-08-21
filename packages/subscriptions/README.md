# @basaltkit/subscriptions

Billing for the Basalt framework, in the style of Laravel Cashier/Soulbscription: declarative plans, subscriptions with a trial period, features with usage limits, Stripe & Paddle integration, and idempotent webhooks. You need this module when your SaaS application charges monthly fees and limits features by plan.

## What this module solves

In a typical SaaS you sell **plans** (e.g. Free, Pro, Enterprise): a plan is a package with a price and a set of **features** — things the customer can or can't do, and in what quantity (3 projects on Free, 50 on Pro; 1000 API calls per month). A **subscription** is the link between a customer and a plan, with a status (active, trialing, past due, canceled).

Implementing this by hand is treacherous: trial periods that expire, mid-month plan changes (with *proration* — the proportional adjustment of the amount), monthly limits that need to reset, and syncing with the payment processor (the *gateway*, e.g. Stripe), which communicates via **webhooks** — HTTP requests the gateway sends to your application when a payment succeeds or fails. Those webhooks arrive duplicated and out of order, and processing them twice corrupts the state.

This module gives you all of that ready to go: you define plans in code (`definePlans`), manage the lifecycle (`subscribe`, `checkout`, `swap`, `cancel`, `resume`), check and consume features (`features(...).can/consume`, with atomic quotas that are never exceeded even under concurrent requests), and process webhooks **idempotently** (each event is applied exactly once, even if it arrives ten times). The local state is the "source of read truth": checking a feature never makes calls to Stripe.

## Installation

```bash
pnpm add @basaltkit/subscriptions
```

The package depends on `@basaltkit/core` and `@basaltkit/fastify` (for HTTP routes and guards) and has `zod` as a *peer dependency*.

## Get started in 5 minutes

1. **Define the plans.** `price: 0` is free; an object gives monthly/yearly prices; `'custom'` is "talk to us". Features can be: boolean (on/off), number (lifetime balance), `meter(n)` (quota that resets every month), or `Infinity` (unlimited):

```ts
// src/billing/plans.ts
import { definePlans, meter } from '@basaltkit/subscriptions'

export const plans = definePlans({
  free: { price: 0, features: { projects: 3, api: false } },
  pro: {
    price: { monthly: 29, yearly: 290 },
    trial: '14d', // 14-day trial period
    features: { projects: 50, api: true, 'api.requests': meter(1000) },
  },
  scale: { price: 'custom', features: { projects: Number.POSITIVE_INFINITY, api: true } },
})
```

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

For development and testing there's `FakeBillingGateway`, which records all calls in arrays (`created`, `canceled`, `checkouts`, `portals`, `swaps`) and accepts the webhook signature `'valid'`.

### Gateway webhooks

`handleWebhook(event)` applies a `WebhookEvent` already translated into domain terms: `subscription.canceled` → `canceled`, `payment.failed` → `past_due`, `payment.succeeded` → `active`. Processing is idempotent by `event.id` (returns `false` for duplicates), and if saving the state fails, the id is released so the gateway's retry can reprocess it.

Over HTTP, use the ready-made route (next section) — signature verification is handled by the gateway driver.

### HTTP integration (plugin, guards, and routes)

`subscriptionsPlugin` registers the service in the container (token `SUBSCRIPTIONS`) and adds route **guards**: with `meta: { subscribed: true | 'plan' }`, the route requires an active subscription (otherwise HTTP 402); with `meta: { feature: 'api' }`, it requires the feature (otherwise HTTP 403). The billable is the tenant from the request context.

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
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

Routes created:

- `POST /billing/checkout` — body `{ plan, period?, successUrl?, cancelUrl? }`, returns `{ url }` to redirect to;
- `POST /billing/portal` — optional body `{ returnUrl? }`, returns `{ url }`;
- `POST /billing/webhook` — endpoint for the gateway; returns 200 with `{ received, duplicate }`.

Important: Stripe verifies the signature over the request's **raw body**. Configure a raw-body parser for the webhook route, so `request.body` arrives as a string.

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

The plugin emits hooks on Basalt's `HookBus`: `billing:subscribed`, `billing:checkout_started`, `billing:swapped`, `billing:canceled`, `billing:trial_expired`, `billing:webhook`. Use them to send emails/notifications:

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

Errors (all with `code` and HTTP `status`): `NotSubscribedError` (`BILLING_SUBSCRIPTION_REQUIRED`, 402), `FeatureUnavailableError` (`BILLING_FEATURE_UNAVAILABLE`, 403), `QuotaExceededError` (`BILLING_QUOTA_EXCEEDED`, 402), `GatewayUnsupportedError` (`BILLING_GATEWAY_UNSUPPORTED`, 501).

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
| `SUBSCRIPTIONS` | Service token in the container |
| `subscriptionsPlugin(options)` | Registers the service and the `meta.subscribed`/`meta.feature` guards; `options` = `SubscriptionsOptions` without `hooks` |
| `billingRoutes({ successUrl, cancelUrl, portalReturnUrl? })` | Routes `POST /billing/checkout` and `POST /billing/portal` for the current tenant |
| `billingWebhookRoute(gateway)` | Route `POST /billing/webhook` — signature verified by the driver, idempotent processing |

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
- **@basaltkit/fastify** — the routes (`billingRoutes`, `billingWebhookRoute`) and the `meta.subscribed`/`meta.feature` guards rest on the HTTP plugin.
- **@basaltkit/mailer** and **@basaltkit/notifications** — subscribe to the `billing:*` hooks to send emails/notifications ("your trial has expired", "payment failed").
- **@basaltkit/webhooks** — the opposite direction: this module *receives* webhooks from the gateway; `@basaltkit/webhooks` *sends* webhooks to your customers (you can forward `billing:*` events there).
- **@basaltkit/scheduler** — the natural place to run `expireTrials()` periodically.
- **@basaltkit/queue** — asynchronous processing of reactions to billing hooks.
