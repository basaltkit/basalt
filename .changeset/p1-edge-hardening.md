---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
---

Edge hardening (security P1):

- **`@basaltkit/fastify`** now defaults `requestTimeout` to **30s** (Fastify's own
  default is disabled), closing a slowloris hole. A caller-supplied
  `fastify.requestTimeout` still wins.
- **`@basaltkit/http`** SSE gains `sse(producer, { heartbeatMs, maxDurationMs })`:
  a comment-ping heartbeat that keeps proxies from dropping idle streams and
  surfaces dead sockets, plus a hard lifetime cap for connections that never
  disconnect. Both off unless set; timers `unref` so they never hold the process open.

New docs: "Resource limits & DoS resistance" (EN+PT) covering request timeouts across
all adapters, SSE limits + backpressure, ceremony-endpoint throttling, and scheduled
custom-domain re-verification.
