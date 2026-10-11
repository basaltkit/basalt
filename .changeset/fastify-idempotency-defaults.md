---
"@basaltkit/fastify": major
---

Requires `@basaltkit/http` 3. `idempotencyPlugin`, re-exported from `@basaltkit/http`, is strict by default: a reused key with a different request (params, query or body) gets `422 IDEMPOTENCY_KEY_REUSED`, and replays run after the guards and validation. `import { idempotencyPlugin } from '@basaltkit/fastify'` changes behaviour accordingly; `idempotencyPlugin({ fingerprint: false, replayAfterGuards: false })` restores 2.x. See the `@basaltkit/http` 3.0.0 notes and https://basaltkit-docs.pages.dev/guide/whats-new#idempotency-strict-by-default

It also inherits http 3's boot refusal of an invalid `meta.responseHeaders`: `fastifyPlugin` runs `assertRouteMetaValid` at boot, so a record that is not an object of string values, carries a CR/LF/NUL, or sets a managed header (`set-cookie`, `content-type`, `content-length`, hop-by-hop, `x-request-id`) refuses the boot with `HTTP_INVALID_ROUTE_META`, where 2.6 printed one warning and sent none of its headers. See https://basaltkit-docs.pages.dev/guide/whats-new#warnings-now-refuse
