---
"@machize/http": minor
"@machize/fastify": minor
"@machize/express": minor
"@machize/hono": minor
---

Framework-neutral HTTP core + Express and Hono adapters:

- New `@machize/http` holds the framework-neutral route pipeline — `route()`, `HttpRequest`/`HttpReply`, validation, enrichers, guards, error mapping (`runRoute`, `toErrorResponse`). Write a route once and run it on any adapter.
- `@machize/fastify` is refactored to build on `@machize/http` (it re-exports `route`/`HttpError`/`RequestEnricher`/`RouteGuard`, so existing imports keep working) — the handler's `request`/`reply` are now the neutral types.
- New `@machize/express` and `@machize/hono` adapters run the exact same routes, enrichers and guards. Tenancy, auth, permissions, validation and error shapes are identical across all three frameworks.
