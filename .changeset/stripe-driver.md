---
"@machize/subscriptions": minor
---

Add a real Stripe billing gateway driver (`StripeBillingGateway`) targeting the
Stripe REST API directly — no `stripe` SDK dependency, injectable fetch, and
webhook signature verification via node:crypto using Stripe's documented scheme.
The `BillingGateway.verifyWebhook` contract now returns `WebhookEvent | null`
(null for verified-but-unmapped events); `billingWebhookRoute` handles the null
case and prefers a raw request body for correct signature verification.
