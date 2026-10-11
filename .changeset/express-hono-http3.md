---
"@basaltkit/express": major
"@basaltkit/hono": major
---

Requires `@basaltkit/http` 3: `idempotencyPlugin` is strict by default (a reused key with a different request gets `422`, replays run after the guards). No API change in the adapter itself; bump `@basaltkit/http` to `^3` together with it. See https://basaltkit-docs.pages.dev/guide/whats-new#idempotency-strict-by-default

The adapters also inherit http 3's boot refusal of an invalid `meta.responseHeaders` (`HTTP_INVALID_ROUTE_META`; 2.1 printed a warning and sent none of its headers): https://basaltkit-docs.pages.dev/guide/whats-new#warnings-now-refuse
