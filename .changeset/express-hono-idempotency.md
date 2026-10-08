---
"@basaltkit/express": minor
"@basaltkit/hono": minor
---

`idempotencyPlugin` from `@basaltkit/http` now works on this adapter (BK-084e) — replays, `409` conflicts, the release of a key refused before the handler (guard `401`/`403`, rate-limit `429`, validation `400`) and the opt-in `fingerprint` / `replayAfterGuards` options behave exactly as on Fastify, held to the shared adapter-parity suite.
