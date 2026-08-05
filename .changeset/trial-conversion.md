---
"@machize/subscriptions": minor
---

Resolve trial→paid conversion (KNOWN_LIMITATIONS #3). Paid plans now create the
gateway subscription up front, with a trial period when the plan has one
(`CreateSubscriptionInput.trialDays` → Stripe `trial_period_days`). The gateway
runs the trial and charges at its end, sending `invoice.paid` (→ active) or
`invoice.payment_failed` (→ past_due), which `handleWebhook` translates to local
state. `expireTrials` now settles only local trials (no `gatewayRef`);
gateway-backed trials are settled by the webhook. All KNOWN_LIMITATIONS items
from the initial code review are now resolved.
