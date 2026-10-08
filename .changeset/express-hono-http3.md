---
"@basaltkit/express": major
"@basaltkit/hono": major
---

Requires `@basaltkit/http` 3: `idempotencyPlugin` is strict by default (a reused key with a different request gets `422`, replays run after the guards). No API change in the adapter itself; bump `@basaltkit/http` to `^3` together with it. See https://basaltkit-docs.pages.dev/guide/whats-new#idempotency-strict-by-default
