---
'@basaltkit/subscriptions': minor
---

Security hardening (B09):

- The Stripe, Paddle and Lemon Squeezy drivers now fail closed when `webhookSecret` is empty, whitespace or missing. `verifyWebhook` throws `BILLING_WEBHOOK_SECRET_MISSING` instead of accepting events signed with an empty HMAC key. The new `requireWebhookSecret()` helper is exported for custom drivers.
- Checkout plan changes follow the plan that was paid. The built-in drivers stamp `plan`/`period` into the gateway's signed metadata and surface them as `WebhookEvent.plan`/`period`. `handleWebhook` promotes a pending plan only when a new gateway subscription attests that plan, so interleaved checkouts can no longer grant a more expensive plan than the one paid. Custom drivers should set `plan` (see the exported `attestedPlan()`). Without it, checkout-driven plan changes are not applied.
- `canceled` is now terminal for the canceled gateway subscription. Late payment events for the same ref (or without a ref) no longer revive access. `swap()` and `cancel()` re-read the record after the gateway call, so a racing swap cannot overwrite a cancel.
- `billingRoutes()` restricts body `successUrl`/`cancelUrl`/`returnUrl` overrides to the configured URLs' origins plus the new `allowedRedirectOrigins` option. Other URLs return `400 BILLING_REDIRECT_NOT_ALLOWED`, which closes an open redirect through the payment provider. The new `meta` option (for example `{ teamRole: 'owner' }`) lets apps restrict checkout and portal to a billing role.
