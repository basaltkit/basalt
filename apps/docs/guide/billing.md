# Subscriptions

`@machize/subscriptions` models billing in your own database, with payment
gateways as drivers. Your app talks to Machize; only drivers talk to Stripe,
Paddle or Lemon Squeezy.

## Define plans

```ts
import { definePlans, meter, subscriptionsPlugin } from '@machize/subscriptions'

subscriptionsPlugin({
  plans: definePlans({
    free: { price: 0, features: { projects: 3, api: false } },
    pro: {
      price: { monthly: 29, yearly: 290 },
      trial: '14d',
      features: { projects: 50, api: true, 'api.requests': meter(100_000) },
    },
    scale: { price: 'custom', features: { projects: Infinity, api: true } },
  }),
  fallbackPlan: 'free',
})
```

Feature values speak for themselves: a boolean is an on/off flag, a number is a
consumable balance, `meter(n)` is a monthly-reset quota, and `Infinity` is
unlimited.

## Subscribe and manage

The billable is the tenant by convention.

```ts
await subscriptions.subscribe('acme', 'pro', { period: 'monthly' })
await subscriptions.swap('acme', 'scale')
await subscriptions.cancel('acme', { atPeriodEnd: true })

await subscriptions.subscribed('acme', 'pro') // boolean
await subscriptions.onTrial('acme')           // boolean
```

## Feature flags and usage

Feature checks read local state — they never call the gateway, so they are
instant:

```ts
const features = subscriptions.features('acme')

await features.can('api')                 // true on pro
await features.remaining('projects')      // 47
await features.consume('api.requests', 1) // metered; throws BILLING_QUOTA_EXCEEDED
```

## Guarding routes

```ts
route({ method: 'GET', url: '/reports', meta: { subscribed: 'pro' }, handler })
route({ method: 'GET', url: '/api/data', meta: { feature: 'api' }, handler })
```

Unmet requirements return `402 BILLING_SUBSCRIPTION_REQUIRED` or
`403 BILLING_FEATURE_UNAVAILABLE`.

## Webhooks

A single endpoint verifies the gateway signature, deduplicates by event id and
translates the payload into domain hooks (`billing:subscribed`,
`billing:webhook`, …). Your app never touches raw gateway payloads.

```ts
import { billingWebhookRoute } from '@machize/subscriptions'

fastifyPlugin({ routes: [...appRoutes, billingWebhookRoute(gateway)] })
```

::: warning Pre-1.0 note
Local state is the read model. A few billing behaviors (atomic metering across a
real usage store, trial→paid conversion through the gateway, durable webhook
idempotency) are deferred until the real gateway/Redis drivers land — see
KNOWN_LIMITATIONS in the repository.
:::
