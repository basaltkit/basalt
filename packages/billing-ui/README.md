# @machize/billing-ui

A self-contained HTML **subscription** page for [`@machize/subscriptions`](https://www.npmjs.com/package/@machize/subscriptions): shows the current plan and the available plans, lets users **subscribe/switch** (hosted Checkout) and **manage billing** (Customer Portal) — **zero dependencies, no build step**. You need this module when you want a ready-to-use "plans & billing" page.

## What this module solves

`@machize/subscriptions` already handles plans, Checkout, and the Portal. This module is the **UI**: a page that reads the current subscription state, presents the plans as cards, and wires the buttons to Checkout (subscribe/switch) and the Customer Portal (manage card/cancel).

## Installation

```bash
pnpm add @machize/billing-ui @machize/subscriptions
```

Depends on `@machize/core`, `@machize/fastify`, and `@machize/subscriptions`.

## Get started in 5 minutes

```ts
import { createApp } from '@machize/core'
import { subscriptionsPlugin, billingRoutes, definePlans, StripeBillingGateway } from '@machize/subscriptions'
import { billingUiRoutes } from '@machize/billing-ui'
import { fastifyPlugin } from '@machize/fastify'

const plans = definePlans({
  free: { price: 0, features: { projects: 3 } },
  pro: { price: 29, trial: '14d', features: { projects: 50, api: true } },
})

const app = await createApp({
  plugins: [
    subscriptionsPlugin({ plans, gateway: new StripeBillingGateway({ /* … */ }), fallbackPlan: 'free' }),
    fastifyPlugin({
      routes: [
        ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/billing' }), // POST /billing/checkout, /billing/portal
        ...billingUiRoutes({ plans }),  // GET /billing/ui + /billing/info
      ],
    }),
  ],
}).boot()
```

Open **`/billing/ui`** (authenticated). The page shows the current plan (with status and trial), lists the plans, and wires the buttons to Checkout/Portal.

## Routes

`billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` adds:

| Route | Description |
|---|---|
| `GET /billing/ui` | The HTML page. |
| `GET /billing/info` | `{ subscription, plans }` for the current tenant. |

Checkout and the Portal (`POST /billing/checkout`, `/billing/portal`) come from `billingRoutes()` in `@machize/subscriptions` — mount those as well.

## Tenancy and authentication

The page performs a same-origin `fetch` (assumes an authenticated session). For **header-based tenancy**, inject the header:

```ts
billingUiRoutes({ plans, headers: { 'x-tenant-id': 'acme' } })
```

Subdomain-based apps need nothing extra.

## API reference

- `billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` — the routes (`plans` is the same object you gave to `subscriptionsPlugin`).
- `billingPageHtml(options)` — the HTML as a string, for serving it your own way.

## How it connects to other modules

- **`@machize/subscriptions`** — plans, Checkout, Portal, subscription state.
- **`@machize/tenancy` / `@machize/auth`** — resolve the tenant and the user.
