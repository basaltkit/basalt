---
'@machize/subscriptions': minor
---

Add hosted Checkout, Customer Portal, and prorated plan changes.

- `Subscriptions.checkout(billableId, plan, { successUrl, cancelUrl, period? })` starts a hosted Checkout flow, records the subscription locally as `incomplete`, and returns the redirect URL. It flips to `active` when the gateway confirms payment via webhook.
- `Subscriptions.portal(billableId, { returnUrl })` opens a Customer Portal session for self-service card/plan/cancel management.
- `Subscriptions.swap(billableId, plan, { prorate? })` now pushes gateway-backed plan changes with proration (`create_prorations` by default; `prorate: false` switches with no immediate settlement).
- `handleWebhook` learns the gateway subscription id from the first event that carries one (`WebhookEvent.gatewayRef`), so Checkout-created subscriptions become manageable.
- New `BillingGateway` capabilities `createCheckoutSession`, `createPortalSession`, `swapSubscription`, implemented by both `FakeBillingGateway` and `StripeBillingGateway` (Checkout Sessions, Billing Portal Sessions, and item-level subscription updates via the Stripe REST API — no SDK).
- New `billingRoutes({ successUrl, cancelUrl, portalReturnUrl? })`: `POST /billing/checkout` and `POST /billing/portal`, scoped to the current tenant. New `SubscriptionStatus` value `incomplete`, `GatewayUnsupportedError` (501), and the `billing:checkout_started` hook.
