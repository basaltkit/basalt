# @basaltkit/subscriptions

## 3.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- 36ab1a1: Give route `meta` a shape, and refuse to boot on a plan that is not in the
  catalogue.
  
  **`meta.subscribed` is now checked at boot.** The toolkit already refused to
  boot a route declaring `meta.subscribed` without `subscriptionsPlugin` — it
  checked the *plugin* existed, never that the *value* meant anything.
  `Subscriptions.subscribed()` compares strings and returns false when they do not
  match, and the guard turns that into a 402. So a route gated on a plan absent
  from the catalogue was indistinguishable from one nobody subscribed to: it
  answered 402 to every paying customer, forever, with nothing in the logs.
  
  `subscriptionsPlugin` now validates every `meta.subscribed` against the plans it
  was given and throws `UnknownPlanMetaError`, naming all offending routes at once
  and listing what the catalogue does have. The check runs on `app:booted`, not in
  the plugin's own boot: adapters publish `http:routes` during *their* boot phase,
  so reading the list earlier would depend on plugin order and silently pass.
  
  **`meta` is typed.** It was `Record<string, unknown>`, so `can: 123` compiled.
  `RouteMeta` is exported from `@basaltkit/http` and augmented by each guard
  plugin — `can` by permissions, `subscribed`/`feature` by subscriptions, `auth`
  by auth — the same pattern `BasaltHooks` uses.
  
  It stays open. The index signature keeps every existing route compiling and lets
  applications add their own keys, which means a **misspelt** key still compiles:
  `subcribed: 'pro'` is not a type error. That gap is closed at boot instead, by
  the two checks above. The typing catches wrong value types and lets an editor
  complete the names.
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 2.8.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 2.8.0

### Minor Changes

- 59cf29c: `subscriptionsPlugin` claims `meta.subscribed` and `meta.feature` in the adapters' guarded-meta boot check.
  
  The plugin registered a guard for both keys but never claimed them, so — together with their absence from `@basaltkit/http`'s `GUARDED_META_KEYS` — a paywalled route in an app that forgot `subscriptionsPlugin` booted and served the paid feature to everyone. Registering the plugin now makes those routes boot; omitting it fails loud instead of failing open. Requires `@basaltkit/http` with the extended key set.

### Patch Changes

- Updated dependencies [59cf29c]
  - @basaltkit/http@1.13.0

## 2.7.0

### Minor Changes

- 5b51958: **Security: billing routes are now authenticated by default, and an abandoned Checkout can no longer escalate a plan.**
  
  **What was exposed (S-1).** `billingRoutes()` (`POST /billing/checkout`, `POST /billing/portal`) and `invoiceRoutes()` (`GET /billing/invoices*`) shipped with no `meta.auth`. Their only identity was the ambient tenant — resolved from unauthenticated request data (Host/`x-tenant-id`). Anyone who could name a tenant could open that tenant's live gateway Customer Portal (cancel the subscription, change the card) or read its invoices. **What changed.** All five routes now carry `meta: { auth: true }` by default; `@basaltkit/auth`'s guard rejects anonymous calls with `401 AUTH_REQUIRED`. **Opt out** only for edge-authenticated deployments: `billingRoutes({ ..., auth: false })` / `invoiceRoutes({ auth: false })`. The webhook route is unchanged — it is authenticated by the gateway signature, never by a session, as before. Note: `meta.auth` is enforced by the auth guard — apps without `authPlugin` (or an equivalent guard) must add one or the meta is inert.
  
  **What was exposed (S-2).** `checkout()` overwrote the local subscription record (`plan`, `status: 'incomplete'`, and it dropped `gatewayRef`). Starting a Checkout for a higher plan and abandoning it left the record reading the escalated plan; the next legitimately-signed renewal webhook for the OLD subscription then flipped it `active` — paid-tier bypass with valid signatures only. Losing `gatewayRef` also silently broke `cancel()`. **What changed.** `checkout()` now merges: an existing record keeps its `plan`/`status`/`gatewayRef`, and the intent rides in the new `pendingPlan`/`pendingPeriod` fields. `handleWebhook` promotes the pending plan **only** when `payment.succeeded` carries a **new** `gatewayRef` (the confirmed Checkout's subscription); a renewal with the same ref — or a ref-less event — activates the current plan only, fail-closed. Webhook processing remains idempotent by event id. Gateways whose success events carry no `gatewayRef` cannot complete plan *changes* (first-time checkouts are unaffected) — ensure your driver forwards the subscription ref.

## 2.6.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 2.6.0

### Minor Changes

- eb2ed54: Add a persistable plan catalog. Plans are consumed as a synchronous `Plans`
  object, so the durable source of truth lives in a `PlanStore` and is loaded once
  at boot: `const plans = await loadPlans(store)` → `subscriptionsPlugin({ plans })`.
  Includes `MemoryPlanStore` (seed it from a `definePlans` object) and
  `plansToStored(plans)` to seed a store. Back the `PlanStore` with your database
  to manage plans in the DB (edit + restart to apply).

## 2.5.0

### Minor Changes

- bb07d0c: Add coupons & discounts (billing depth). A `Coupon` is `percentOff` (0–100) or a
  fixed `amountOff` (minor units + currency), with optional `maxRedemptions` and
  `redeemBy` expiry. `couponDiscount()` computes the discount on a subtotal;
  `Invoices.draft({ coupon })` applies it (on top of any explicit discount, clamped
  to the subtotal) and records `couponCode`. A `Coupons` registry (with
  `CouponStore`/`MemoryCouponStore`) defines, quotes (validating redeemability) and
  redeems codes. Pure domain — no HTTP, no gateway.
- c1483ec: Add metered-billing depth: tiered pricing (`TieredPrice` with `graduated` or
  `volume` mode) via `tieredCost(price, units)`, and `meteredLine(feature, { units,
price, includedUnits })` to turn recorded usage into an invoice line (subtracting
  the plan's free allowance; `null` when nothing is billable). Complements the flat
  `overageLine`. Pure domain.

### Patch Changes

- Updated dependencies [0768769]
  - @basaltkit/http@1.6.0

## 2.4.0

### Minor Changes

- a163d85: Add invoicing (billing depth): an `Invoices` engine with a draft → open → paid
  state machine, line items, discount/tax and totals in minor units, plus
  `planLine`/`overageLine` builders, text/HTML renderers, a `MemoryInvoiceStore`
  (and `InvoiceStore` interface) and an `INVOICES` DI token. `invoiceRoutes()`
  exposes read-only per-tenant invoice endpoints built on the neutral `route()` —
  verified on the Fastify, Express and Hono adapters.

## 2.3.0

### Minor Changes

- 3125a96: Add a **Lemon Squeezy** billing gateway (`LemonSqueezyBillingGateway`) — same no-SDK, `fetch`-based contract as Stripe/Paddle, over the Lemon Squeezy JSON:API:

  - `createSubscription` / `createCheckoutSession` (checkout-first — creates a checkout with your store + variant), `cancelSubscription` (DELETE), `createPortalSession` (reads the customer's `customer_portal` url), `swapSubscription` (proration → `disable_prorations` / `invoice_immediately`).
  - `verifyWebhook` implements the `X-Signature` scheme (bare HMAC-SHA256 hex over the raw body, timing-safe) and maps `subscription_payment_success` → `payment.succeeded`, `subscription_payment_failed` → `payment.failed`, `subscription_cancelled`/`subscription_expired` → `subscription.canceled`. `billableId` reads `meta.custom_data.billableId`.

  With this, all three merchant gateways (Stripe, Paddle, Lemon Squeezy) ship.

### Patch Changes

- Updated dependencies [2fb6c59]
  - @basaltkit/fastify@1.4.0

## 2.2.0

### Minor Changes

- Security: **`PaymentLedger.apply` refuses to settle a payment for the wrong amount.** When a `payment.succeeded` event's `amount` differs from the amount originally recorded for that payment id (via `created`), the ledger throws the new `PaymentAmountMismatchError` and releases the idempotency claim instead of marking it paid — blocking underpayments and forged/mis-routed callbacks that would settle an invoice for less. Webhook-first payments (no prior record) are unaffected. Also exports `WebhookSecretMissingError` for gateways that fail closed when no signing secret is configured.

## 2.1.0

### Minor Changes

- `PaymentLedger` gains **lifecycle hooks**: `ledger.on('recorded' | 'confirmed'
| 'failed', listener)` lets apps react to payment state changes (notifications,
  analytics) without touching the store. Listeners are **best-effort** — they run
  after the payment is safely persisted, fire only on a fresh (non-deduped)
  apply, and a throwing one never rolls back the payment (it's reported via the
  new `onListenerError` option). `on()` returns an unsubscribe function.

## 2.0.0

### Major Changes

- **BREAKING: money is now integers in the currency's minor unit** (cents;
  `100 = 1.00`), the Stripe/Adyen convention — exact, no float rounding, no
  unit ambiguity. This affects every `amount` (`PaymentRequest`,
  `PaymentInstruction.reference`, `PaymentEvent`, `PaymentRecord`,
  `RecurringSubscription`/`SubscribeInput`) and plan `price`. Callers passing a
  major-unit value (`5000` for 5.000 Kz, `29.99` for $29.99) must switch to
  minor units (`500000`, `2999`).
- New `money` helpers: `toMinor`/`toMajor`/`formatMoney`/`currencyDecimals` for
  the human boundary, and `assertMinorUnits`/`isMinorUnits` for validation.
- Payment gateway drivers (`subscriptions-proxypay` ≥ 2.0, `subscriptions-appypay`)
  translate minor units to each provider's expected format. Upgrade drivers in
  lockstep.

## 1.2.0

### Minor Changes

- Add **recurring reference billing** for card-less gateways (ProxyPay, AppyPay,
  Multicaixa/EMIS): `RecurringReferenceBilling` models a subscription as one
  payment reference per period. `subscribe` issues the first reference,
  `issueNext` issues the next (for the ones `due()` returns), and `handleEvent`
  extends `paidThrough` by one interval when a reference is paid (or marks
  `past_due` on failure) — applied exactly once via the payment ledger. Ships
  with `MemoryRecurringStore` (`RecurringStore` to back it durably) and an
  `addInterval` helper.
- `PaymentLedger.apply` now takes an optional `onFresh` callback that runs inside
  the idempotency claim, so a domain side effect (activate a subscription, mark a
  booking paid) applies atomically with the payment and is released together on
  failure.

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
