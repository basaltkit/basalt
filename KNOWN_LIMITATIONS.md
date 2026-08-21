# Known Limitations

Items surfaced by code review as the ecosystem matured. **All are resolved** —
this file is kept as the record of what they were and how they were fixed, not
a list of open issues. #2–#4 (fixed in 0.1.x) concerned behavior that only bites
with a real backend (Redis, a payment gateway) and landed with those drivers;
#5 (fixed across 0.25.0–0.31.0) was the broader "stores ship in-memory only"
limitation, now closed by durable SQLite/Prisma backends for every stateful
domain. There are no open limitations tracked here — forward-looking work toward
a stable 1.0 lives in [RELEASE_1.0_CHECKLIST.md](./RELEASE_1.0_CHECKLIST.md).

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

---

## #5 — Several domain stores shipped in-memory only — RESOLVED in 0.25.0–0.31.0

**Resolution:** every stateful domain now has a durable backend behind the same
store contract, so in-memory is the dev default rather than a ceiling. Auth,
teams, subscriptions, permissions, comments, audit, activity and notifications
each ship an `@basaltkit/<domain>-sqlite` (Node's built-in `node:sqlite`,
zero-dependency, single-node) and an `@basaltkit/<domain>-prisma` (PostgreSQL/MySQL)
package — 18 store packages in all. Cache, usage metering and webhook idempotency
already had Redis backends; queues, search and storage have production drivers;
feature flags are stateless by design. Switching a store is a one-line change
because the contract is unchanged. See the [Persistence guide][p] and the
[Database-per-tenant guide][dpt]; remaining 1.0 work is tracked in
[RELEASE_1.0_CHECKLIST.md](./RELEASE_1.0_CHECKLIST.md).

[p]: https://basaltkit-docs.pages.dev/guide/persistence
[dpt]: https://basaltkit-docs.pages.dev/guide/database-per-tenant
