---
"@machize/fastify": minor
---

`idempotencyPlugin`: safe retries for mutating requests. When a client sends an
`Idempotency-Key`, the first response is cached and replayed for repeats with
the same key (scoped by method + route), so a network retry never performs the
operation twice. In-flight duplicates get `409 IDEMPOTENCY_CONFLICT`; `5xx`
responses are not cached so real failures stay retryable. Pluggable store
(in-memory default).
