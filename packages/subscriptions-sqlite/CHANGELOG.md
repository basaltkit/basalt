# @basaltkit/subscriptions-sqlite

## 3.0.0

### Major Changes

- e53db52: Billing fixes from the framework audit, pass 2 (FA-046…FA-055, FA-071).
  
  - **`swap()` no longer grants a paid plan for free (FA-046).** A subscription with no gateway subscription behind it (a free or locally granted one) swapped onto a paid plan used to go straight to `active` on that plan without anything being charged. It now throws the new `PaymentRequiredError` (`BILLING_PAYMENT_REQUIRED`, 402) for a paid or `'custom'` target; downgrading to a free plan still works. Pass `swap(id, plan, { allowUnpaid: true })` when payment really is collected elsewhere (manual invoicing, reference payments, sales-led deals). A gateway-backed subscription whose gateway has no `swapSubscription` now throws `GatewayUnsupportedError` instead of changing only the local plan while the gateway keeps charging the old price.
  - **Usage amounts must be positive integers (FA-047).** `features().consume(feature, amount)` accepted negative amounts (handing quota back) and `NaN` (after which `NaN + 1 > limit` was always false, so the quota never bound again). `consume()` and every `UsageStore` — memory, Redis (also guarded in the Lua script), SQLite and Prisma — now reject anything but a positive safe integer with the new `InvalidUsageAmountError` (`BILLING_INVALID_USAGE_AMOUNT`, 400). New export `assertUsageAmount()` for custom stores.
  - **Webhooks only act on the subscription they name (FA-048).** A `subscription.canceled` for a different gateway subscription (an old, replaced one) canceled the active subscription and overwrote its `gatewayRef`; a `payment.failed` for it made the active one `past_due`. Both are now ignored (the event is still recorded as processed and `billing:webhook` still fires). A cancel naming a gateway subscription on a local record that is not waiting for one is ignored too.
  - **Plan lookups use own keys only (FA-049).** `plan('constructor')`, `plan('__proto__')` and friends resolved through the prototype; they now throw `UnknownPlanError`. Feature lookups and the drivers' event maps got the same treatment.
  - **Lemon Squeezy renewals are no longer dropped as duplicates (FA-052).** The idempotency key was `${event}:${subscriptionId}`, so every renewal after the first matched the first one and was skipped. The key is now the event name, the object id (the subscription invoice on payment events) and its `updated_at` — stable across re-deliveries, distinct between events.
  - **`billingWebhookRoute` reads each driver's signature header (FA-053).** It only read `stripe-signature` / `x-billing-signature`, so every Paddle (`Paddle-Signature`) and Lemon Squeezy (`X-Signature`) delivery answered 400. `BillingGateway` gains an optional `signatureHeader` (declared by the Stripe, Paddle and Lemon Squeezy drivers); drivers without one keep the old fallback, and `billingWebhookRoute(gateway, { signatureHeader })` overrides it.
  - **Checkout-first gateways and `resume()` (FA-054).** Paddle's and Lemon Squeezy's `createSubscription` returned a transaction/checkout id as if it were a subscription: `subscribe()` activated the paid plan before anything was paid, and `cancel()`/`swap()` later addressed `/subscriptions/txn_…`. They now throw the new `CheckoutRequiredError` (`BILLING_CHECKOUT_REQUIRED`, 501) — use `checkout()`. `resume()` now withdraws the scheduled cancellation at the gateway through the new optional `BillingGateway.resumeSubscription` (implemented by Stripe, Paddle, Lemon Squeezy and `FakeBillingGateway`, which records it in `resumed`); a gateway-backed subscription whose gateway cannot resume throws `GatewayUnsupportedError` instead of drifting.
  - **Coupons, invoices, ledger (FA-055).** `Coupons.redeem()` now enforces `redeemBy` and `maxRedemptions` itself, atomically: `CouponStore.incrementRedemptions(code, limit?)` increments only below `limit` and returns `null` at the cap (a store that ignores `limit` still works, `redeem()` rejects a count above the cap). `percentOff: NaN`, a non-integer `maxRedemptions` and a non-finite `redeemBy` are invalid coupon shapes. `Invoices` rejects a line `quantity` that is not a positive integer, a negative/`NaN` `tax`, `discount` or tax rate, and a `currency` that is not a 3-letter code, with the new `InvoiceInputError` (`INVOICE_INVALID_INPUT`, 400). `renderInvoiceHtml` escapes every interpolated value — the Intl fallback printed a hostile `currency` raw. `PaymentLedger.apply` is a state machine: `paid` is terminal, so a late `payment.failed` or a second `payment.succeeded` under a new event id changes nothing, skips `onFresh` and returns `fresh: false`; a `payment.failed` no longer overwrites the requested amount (which disarmed the underpayment check).
  - **Smaller items (FA-071).** A non-string or empty `meta.feature` fails closed (403) instead of being skipped. Stripe (`v1`) and Paddle (`h1`) accept any of several signatures in one header, as sent during a secret rotation. Lemon Squeezy gains an opt-in replay window, `maxEventAgeSeconds` (+ `now`). `Subscriptions` and `RecurringReferenceBilling` take an injectable `now` clock; `expireTrials()` settles a trial on a plan removed from the catalogue as `past_due` instead of aborting the sweep; `addInterval` adds months in UTC and clamps to the month end (Jan 31 → Feb 28/29, not Mar 2/3). ProxyPay: a whitespace-only secret fails closed, a malformed signed body is a 400 (`WebhookInvalidError`) instead of a 500, and `metadata` can no longer override `billable_id`/`reference` in `custom_fields`.
  
  **Why major, and how to migrate:**
  
  - `swap()` onto a paid plan from a subscription without a `gatewayRef` now throws. Send those customers through `checkout()`, or pass `{ allowUnpaid: true }` where payment is collected outside the gateway.
  - `subscribe()` to a paid plan with `PaddleBillingGateway` / `LemonSqueezyBillingGateway` now throws `CheckoutRequiredError`: use `checkout()`. Records previously created that way carry a transaction/checkout id as `gatewayRef` (it never addressed a subscription); clear it or set it to the real `sub_…` id, otherwise webhooks for the real subscription are treated as belonging to another one.
  - `resume()` of a gateway-backed subscription now calls the gateway; a custom `BillingGateway` must implement `resumeSubscription` or `resume()` throws `GatewayUnsupportedError`.
  - `consume()` / `UsageStore` reject fractional amounts (they never fitted the integer counters of the durable stores) as well as zero, negative and `NaN` ones.
  - Invoice drafts with a fractional/zero quantity, negative tax or a non-ISO currency now throw.
  - `CouponStore.incrementRedemptions` is typed `(code, limit?) => Promise<number | null>`; callers reading its result must handle `null`. Custom stores should honour `limit` atomically.
  - `PaymentLedger.apply` returns `fresh: false` for events on an already-paid payment.
  - `@basaltkit/subscriptions-prisma` / `-sqlite` stores import `assertUsageAmount`, so they require `@basaltkit/subscriptions` 5.

### Patch Changes

- Updated dependencies [e53db52]
  - @basaltkit/subscriptions@5.0.0

## 2.2.3

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/subscriptions@4.0.0

## 2.2.2

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/subscriptions@3.0.0

## 2.2.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 2.2.0

### Minor Changes

- 5b51958: Persist the `pendingPlan` / `pendingPeriod` fields backing `@basaltkit/subscriptions`' checkout-escalation guard.
  
  - **subscriptions-prisma:** the reference `schema.prisma` gains two optional columns (`pendingPlan String?`, `pendingPeriod String?`). **Action required:** re-sync your app schema (`basalt prisma:sync`) and run a migration; the store now always writes these columns, so an un-migrated database will fail loudly on save rather than silently mis-handling a plan change.
  - **subscriptions-sqlite:** columns are added automatically (`ALTER TABLE … ADD COLUMN` on open, tolerated when they already exist) — no action needed.

## 2.1.0

### Minor Changes

- Add durable **payment ledger + recurring** stores (parity with
  `@basaltkit/subscriptions-prisma`): `SqlitePaymentStore` (`PaymentStore`) and
  `SqliteRecurringStore` (`RecurringStore`), plus the `sqlitePaymentStores()`
  factory. `create` is an idempotent `INSERT OR IGNORE`; money is a 64-bit
  `INTEGER` (minor units). New `payments` and `recurring_subscriptions` tables in
  the migration.

## 2.0.0

### Major Changes

- Move to `@basaltkit/subscriptions@2.0` (money in minor units). No code changes
  in this package — the store interfaces it implements are unchanged; the major
  bump only widens the peer range to `^2.0.0`.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.2

### Patch Changes

- Add `PRAGMA busy_timeout = 5000` so a write waits for a competing writer's
  lock (up to 5s) instead of throwing `database is locked` immediately. Prevents
  spurious 500s under dev auto-reload (`tsx watch`) or concurrent writers.

## 1.0.1

### Patch Changes

- Fix a runtime crash when consumed from the published package: the bundler
  stripped the `node:` prefix from the `node:sqlite` import, emitting a broken
  `from "sqlite"` that failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'sqlite'`.
  The builtin is now loaded through an opaque specifier the bundler leaves intact.

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.28.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementations of the three
  `@basaltkit/subscriptions` stores — subscriptions, usage metering and webhook
  idempotency — on Node's built-in `node:sqlite`, with zero external
  dependencies. The metered `consume()` is atomic (a `BEGIN IMMEDIATE`
  transaction with a `RETURNING` guard), so a quota is never overshot under
  concurrency. `sqliteSubscriptionsStores(location)` returns all three stores
  named to drop straight into `subscriptionsPlugin`. The single-node counterpart
  to `@basaltkit/subscriptions-prisma`.
