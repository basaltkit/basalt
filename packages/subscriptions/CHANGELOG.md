# @basaltkit/subscriptions

## 1.1.0

### Minor Changes

- Add a **payment ledger + webhook idempotency** for the `PaymentGateway` side:
  `PaymentStore` (+ `MemoryPaymentStore`) tracks payments keyed by the gateway
  payment id, and `PaymentLedger` records a payment as `pending` on create and
  applies each verified `PaymentEvent` exactly once — deduping retried callbacks
  by `event.id` (reusing `WebhookStore`) and flipping the record to
  `paid`/`failed`. Apps no longer hand-roll this per integration. Back
  `PaymentStore` with your database for durability.

## 1.0.1

### Minor Changes

- Add the `PaymentGateway` contract for one-off / reference / mobile-money
  payments — `PaymentRequest`, `PaymentInstruction`, `PaymentEvent`, and
  `FakePaymentGateway`. Complements `BillingGateway` (card subscriptions) for
  providers with no card-on-file recurring or portal (Angola: Multicaixa/EMIS,
  ProxyPay, AppyPay, UNITEL Money). First driver: `@basaltkit/subscriptions-proxypay`.

<!-- Entries below predate the Machize → Basalt rebrand (published under @machize). -->

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/fastify@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/fastify@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/fastify@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/fastify@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/fastify@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/fastify@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/fastify@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/fastify@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Minor Changes

- ec514e5: Add hosted Checkout, Customer Portal, and prorated plan changes.

  - `Subscriptions.checkout(billableId, plan, { successUrl, cancelUrl, period? })` starts a hosted Checkout flow, records the subscription locally as `incomplete`, and returns the redirect URL. It flips to `active` when the gateway confirms payment via webhook.
  - `Subscriptions.portal(billableId, { returnUrl })` opens a Customer Portal session for self-service card/plan/cancel management.
  - `Subscriptions.swap(billableId, plan, { prorate? })` now pushes gateway-backed plan changes with proration (`create_prorations` by default; `prorate: false` switches with no immediate settlement).
  - `handleWebhook` learns the gateway subscription id from the first event that carries one (`WebhookEvent.gatewayRef`), so Checkout-created subscriptions become manageable.
  - New `BillingGateway` capabilities `createCheckoutSession`, `createPortalSession`, `swapSubscription`, implemented by both `FakeBillingGateway` and `StripeBillingGateway` (Checkout Sessions, Billing Portal Sessions, and item-level subscription updates via the Stripe REST API — no SDK).
  - New `billingRoutes({ successUrl, cancelUrl, portalReturnUrl? })`: `POST /billing/checkout` and `POST /billing/portal`, scoped to the current tenant. New `SubscriptionStatus` value `incomplete`, `GatewayUnsupportedError` (501), and the `billing:checkout_started` hook.

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/fastify@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/fastify@0.4.0
  - @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @basaltkit/fastify@0.3.0
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
  - @basaltkit/fastify@0.1.0
