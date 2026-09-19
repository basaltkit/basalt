---
'@basaltkit/http': minor
---

Security hardening (B11-http):

- `securityPlugin` now sends `Cache-Control: no-store` by default so responses carrying tokens, API keys or MFA secrets are not cached (`headers.cacheControl` to change it or `false` to omit; a route's own header still wins).
- Per-route `meta.rateLimit` is now enforced by a route guard, so it holds on Express and Hono (where it was silently ignored) and for routes invoked as MCP tools, not only on Fastify.
- `MemoryRateLimitStore` sweeps expired buckets and caps live ones (`maxEntries`, default 100 000, oldest evicted first) so distinct client addresses cannot grow memory without bound; the constructor also accepts an options object.
- `toErrorResponse` keeps framework client errors (malformed JSON, oversized or unsupported bodies) as 400/413/415 with fixed messages, reported at `warn`, instead of a 500 `INTERNAL_ERROR`; statuses on arbitrary errors are still not trusted.
- Error reports and tracing spans mask query-string values (`[REDACTED]`); new `redactUrl` helper.
- Inbound `x-request-id` / `x-correlation-id` are adopted only when they match `^[A-Za-z0-9._:-]{1,128}$`; otherwise a fresh id is generated.
- `RouteGuard` receives an optional `reply` so guards can set response headers before rejecting.
