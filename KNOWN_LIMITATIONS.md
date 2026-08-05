# Known Limitations

Deferred items surfaced by the code review of the initial scaffold. None of
them bite with the in-memory stores that ship today; each becomes relevant
when a real backend (Redis, a payment gateway, a SQL `UsageStore`) is wired
in. They are tracked here so the fix lands together with the backend that
needs it, and referenced from the code with
`// KNOWN LIMITATION (see KNOWN_LIMITATIONS.md #N)`.

---

## #2 — Metered `consume()` is check-then-increment (not atomic)

**Where:** `packages/subscriptions/src/subscriptions.ts` — `Subscriptions.features().consume`

**What:** `consume` reads current usage, checks it against the limit, then
increments — three separate steps. With the synchronous `MemoryUsageStore`
this is safe. With any asynchronous `UsageStore` (Redis, SQL) two concurrent
`consume` calls can both read `used = 999` (limit `1000`), both pass the
check, and both increment → `1001`, exceeding the quota.

**Why deferred:** only reproducible with a real async store, which does not
exist yet.

**Fix plan:** make consumption atomic. Either

- add an atomic "increment and return new total" to the `UsageStore`
  contract and check the returned total (rolling back / raising when it
  overshoots), or
- use a Redis `INCRBY` + compare, or a SQL `UPDATE ... WHERE used + :n <= :limit`
  that reports whether a row was affected.

The current `increment` already returns the new total, so the seam is small.

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
