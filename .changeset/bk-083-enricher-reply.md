---
'@basaltkit/http': minor
---

BK-083: `RequestEnricher` receives the optional `reply`, so an enricher that refuses a request can set a response header first (e.g. `WWW-Authenticate`). The header survives the shared error envelope on fastify, express and hono (covered by the adapter parity matrix).
