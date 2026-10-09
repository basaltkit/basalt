---
"@basaltkit/http": minor
---

Route-scoped static response headers (BK-085): `meta.responseHeaders: Record<string, string>` is applied by the shared pipeline as soon as the route matches, before enrichers and guards, so the headers are on every response the route produces — success, a guard's `401`/`403`, a validation `400`, a thrown `500` — identically on Fastify, Express and Hono. They replace a global header of the same name; a handler can still override one. Checked at boot on every adapter: string values without control characters, and never `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, hop-by-hop headers or `x-request-id`. An invalid record logs one `[basalt] invalid meta.responseHeaders …` boot warning naming the routes and is ignored WHOLE (none of its headers, valid siblings included, is ever sent; the request never fails because of it). The next major refuses the boot instead.

The key is `responseHeaders`, not `headers`: `RouteMeta` is an app-owned bag, and an app that already keeps its own data under `meta.headers` (say OpenAPI-style request-header docs) is untouched — nothing reads `meta.headers`, and it is never sent to clients.
