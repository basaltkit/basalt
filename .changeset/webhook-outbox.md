---
'@basaltkit/webhooks': minor
---

Add a durable, at-least-once integration-events bridge over the app's own
webhooks. `webhookOutboxPlugin({ events, store, intervalMs })` captures domain
events into a transactional outbox (from `@basaltkit/events`) and relays them to
webhook subscribers with retries — unlike `webhooksPlugin({ events })`, which is
fire-and-forget and loses events on failure or a crash. `webhookOutboxDispatch
(webhooks)` is the underlying `OutboxDispatch` for manual wiring; resolve the
`OUTBOX` token to enqueue or flush yourself (e.g. from a queue worker).
