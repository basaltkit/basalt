---
"@basaltkit/fastify": patch
---

Fix `idempotencyPlugin` for handlers that return their payload (FA-001).

With `idempotencyPlugin()`, a route whose handler *returns* a value — the shape every `route()` example uses — was never replayed: the handler ran on every retry of the same `Idempotency-Key`, and every response reported a spurious `500` (`ERR_HTTP_HEADERS_SENT`) to `onError`. Only handlers that called `reply.code().send()` themselves were covered. The adapter now tracks whether it sent the reply itself (Fastify's `reply.sent` stays `false` while an async `onSend` hook runs) and returns the reply to Fastify instead of resolving with `undefined`, so the response is sent exactly once. This also fixes the same double send for thrown errors and for edge pre-hooks (a rate-limit `429`) whenever any async `onSend` hook is installed.
