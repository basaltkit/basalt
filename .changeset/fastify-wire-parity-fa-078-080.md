---
"@basaltkit/fastify": minor
---

Wire-level parity with Express and Hono (framework audit FA-078…FA-080).

- An `sse()` response keeps the headers set before it (CORS, security headers,
  rate-limit counters, `x-request-id`): the hijacked reply used to drop them, so
  a cross-origin `EventSource` failed its CORS check. The headers are flushed at
  once, so a stream that starts quiet still opens.
- Structured `+json` bodies (`application/merge-patch+json`,
  `application/vnd.api+json`) are parsed as JSON, as on every adapter (they were
  answered `415`). A malformed JSON body answers `400 BAD_REQUEST` with the same
  message as Express and Hono ("Malformed request body.").
- After-hooks (metrics, tracing) now run for every request, including hijacked
  `sse()` replies and responses the client abandoned — Fastify's `onResponse`
  skipped both, so `http_requests_in_flight` leaked. A failing after-hook is
  reported through `onError` (`AFTER_HOOK_FAILED`).
