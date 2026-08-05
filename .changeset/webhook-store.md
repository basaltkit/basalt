---
"@machize/subscriptions": minor
---

Resolve per-process webhook idempotency (KNOWN_LIMITATIONS #4). A `WebhookStore`
seam now dedupes processing: `markProcessed(id)` claims an event id and
`release(id)` frees it. `handleWebhook` claims the id, applies the change, and
releases the claim if persistence throws — so a failed apply is retried by the
gateway rather than silently deduped. `RedisWebhookStore` implements it with
`SET key value NX EX`, so idempotency holds across restarts and multiple
instances; `MemoryWebhookStore` remains the default for single-process/dev.
