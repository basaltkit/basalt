# Known Limitations

Deferred items surfaced by the code review of the initial scaffold. None of
them bite with the in-memory stores that ship today; each becomes relevant
when a real backend (Redis, a payment gateway, a SQL `UsageStore`) is wired
in. They are tracked here so the fix lands together with the backend that
needs it, and referenced from the code with
`// KNOWN LIMITATION (see KNOWN_LIMITATIONS.md #N)`.

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

## #3 — Trial → paid conversion never reaches the gateway

**Where:** `packages/subscriptions/src/subscriptions.ts` — `Subscriptions.subscribe`
and `Subscriptions.expireTrials`

**What:** `subscribe` skips the gateway when a plan has a trial; `expireTrials`
only flips the status to `past_due`. Nothing creates the gateway subscription
at trial end, so a trialing customer who added a card is never charged, and
one who did not never converts.

**Why deferred:** there is no real gateway driver yet (only `FakeBillingGateway`),
so the conversion has nothing to talk to.

**Fix plan:** model trials the way real gateways do — create the gateway
subscription up front with a trial period (Stripe `trial_period_days`,
Paddle/Lemon equivalents) and let the gateway drive the trial-end charge via
its webhook, which `handleWebhook` already translates to local state. This
lands with the Stripe driver (roadmap Phase 5 follow-up).

---

## #4 — Webhook idempotency is per-process

**Where:** `packages/subscriptions/src/subscriptions.ts` — `Subscriptions.handleWebhook`
(the `seenWebhooks` set)

**What:** processed webhook ids are deduplicated in an in-memory `Set`. Across
process restarts or with more than one instance, the dedup is lost and an
event can be reprocessed — despite the method being named idempotent. Swapping
the `SubscriptionStore` for a database does not help, because there is no seam
to persist the seen ids.

**Why deferred:** single-process/in-memory is fine for the current scaffold;
the durable guarantee only matters in a real multi-instance deployment.

**Fix plan:** persist processed event ids. Add a `WebhookStore` (or extend
`SubscriptionStore`) with `markProcessed(id): boolean` returning whether the id
was new, backed by Redis `SET NX` or a unique DB column. Consume it at the top
of `handleWebhook`. Lands with the Redis/DB stores.
