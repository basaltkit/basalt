---
"@basaltkit/express": minor
"@basaltkit/hono": minor
---

`idempotencyPlugin` from `@basaltkit/http` now works on this adapter (BK-084e) — replays, `409` conflicts and the opt-in `fingerprint` / `replayAfterGuards` options behave exactly as on Fastify, held to the shared adapter-parity suite.
