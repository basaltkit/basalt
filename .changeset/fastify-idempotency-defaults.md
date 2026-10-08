---
"@basaltkit/fastify": major
---

Requires `@basaltkit/http` 3. `idempotencyPlugin`, re-exported from `@basaltkit/http`, is strict by default: a reused key with a different request (params, query or body) gets `422 IDEMPOTENCY_KEY_REUSED`, and replays run after the guards and validation. `import { idempotencyPlugin } from '@basaltkit/fastify'` changes behaviour accordingly; `idempotencyPlugin({ fingerprint: false, replayAfterGuards: false })` restores 2.x. See the `@basaltkit/http` 3.0.0 notes and https://basaltkit-docs.pages.dev/guide/whats-new#idempotency-strict-by-default
