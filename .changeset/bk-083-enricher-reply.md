---
'@basaltkit/http': minor
---

BK-083: `RequestEnricher` receives the optional `reply`, so an enricher that refuses a request can set a response header first (e.g. `WWW-Authenticate`). The header survives the shared error envelope on fastify, express and hono (covered by the adapter parity matrix). An enricher that answers the request itself with `reply.send()` now ends it: the remaining enrichers, the guards and the handler no longer run behind a response already sent.
