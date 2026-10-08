---
"@basaltkit/http": minor
---

Route-scoped static response headers (BK-085): `meta.headers: Record<string, string>` is applied by the shared pipeline as soon as the route matches, before enrichers and guards, so the headers are on every response the route produces — success, a guard's `401`/`403`, a validation `400`, a thrown `500` — identically on Fastify, Express and Hono. They replace a global header of the same name; a handler can still override one. Validated at boot through `assertRouteMetaValid` (`InvalidRouteMetaError`): string values without control characters, and never `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, hop-by-hop headers or `x-request-id`.
