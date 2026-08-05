# Known Limitations

Items surfaced by the code review of the initial scaffold. All three have since
been **resolved in 0.1.x** — this file is kept as the record of what they were
and how they were fixed. Each concerned behavior that only bites with a real
backend (Redis, a payment gateway); the fixes landed together with those
drivers.

---

## #2 — Metered `consume()` is check-then-increment (not atomic) — RESOLVED in 0.1.x

**Resolution:** the `UsageStore` contract gained an atomic
`consume(billableId, feature, periodKey, amount, limit)` that increments only
if the result stays within the limit, returning `{ applied, used }`.
`MemoryUsageStore` implements it without an `await` between read and write
(atomic in the event loop); `RedisUsageStore` implements it with a Lua script
run via `EVAL`, which Redis executes atomically — so concurrent callers can
never overshoot. `Subscriptions.features().consume` now routes limited features
through it (unlimited features are just tracked).

---

## #3 — Trial → paid conversion never reaches the gateway — RESOLVED in 0.1.x

**Resolution:** paid plans now create the gateway subscription up front, with a
trial period when the plan has one (`CreateSubscriptionInput.trialDays` →
Stripe `trial_period_days`). The gateway runs the trial and charges at its end,
sending `invoice.paid` (→ active) or `invoice.payment_failed` (→ past_due),
which `handleWebhook` already translates to local state. `expireTrials` now only
settles **local** trials (those without a `gatewayRef`); gateway-backed trials
are settled by the webhook, not the scheduler.

---

## #4 — Webhook idempotency is per-process — RESOLVED in 0.1.x

**Resolution:** a `WebhookStore` seam now dedupes processing —
`markProcessed(id)` claims an event id (true = new) and `release(id)` frees it.
`handleWebhook` claims the id, applies the change, and releases the claim if
persistence throws so the gateway's retry can reprocess (rather than being
silently deduped). `RedisWebhookStore` implements it with `SET key value NX EX`,
so idempotency holds across restarts and multiple instances; `MemoryWebhookStore`
is the default for single-process/dev.
