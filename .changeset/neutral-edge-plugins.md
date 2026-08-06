---
"@machize/http": minor
"@machize/fastify": minor
"@machize/express": minor
"@machize/hono": minor
---

Framework-neutral edge plugins. `securityPlugin`, `healthPlugin`, `metricsPlugin`,
`tracingPlugin` and `openapiPlugin` now target a neutral `HttpServer` (the new
`HTTP_SERVER` token that every adapter provides), so they run unchanged on
Fastify, Express and Hono. They moved into `@machize/http` and are re-exported
from `@machize/fastify` for back-compat. `idempotencyPlugin` stays Fastify-specific
(it intercepts the response body). Adapters now expose `use`/`after`/`addRoute`
via an `HttpServerCollector` mounted after all plugins register.
