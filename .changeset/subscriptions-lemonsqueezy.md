---
"@basaltkit/subscriptions": minor
---

Add a **Lemon Squeezy** billing gateway (`LemonSqueezyBillingGateway`) — same no-SDK, `fetch`-based contract as Stripe/Paddle, over the Lemon Squeezy JSON:API:

- `createSubscription` / `createCheckoutSession` (checkout-first — creates a checkout with your store + variant), `cancelSubscription` (DELETE), `createPortalSession` (reads the customer's `customer_portal` url), `swapSubscription` (proration → `disable_prorations` / `invoice_immediately`).
- `verifyWebhook` implements the `X-Signature` scheme (bare HMAC-SHA256 hex over the raw body, timing-safe) and maps `subscription_payment_success` → `payment.succeeded`, `subscription_payment_failed` → `payment.failed`, `subscription_cancelled`/`subscription_expired` → `subscription.canceled`. `billableId` reads `meta.custom_data.billableId`.

With this, all three merchant gateways (Stripe, Paddle, Lemon Squeezy) ship.
