---
"@basaltkit/http": minor
---

Adapter parity helpers and fixes (framework audit FA-080, FA-H25).

- `metricsPlugin`: the `http_requests_in_flight` gauge counts per request. A
  pre-hook that answered before the metrics hook ran (a 429, a CORS preflight)
  still ran the after-hook, and the gauge went negative.
- `assertRoutesGuarded(routes, container, allow?)` now also takes a booted
  app's container, reading the claimed keys from it — the same boot check the
  adapters make, for code that calls `runRoute()` without an adapter.
- New `isJsonMediaType()`, `mediaTypeOf()` and `DEFAULT_BODY_LIMIT` (1 MiB): the
  one rule every adapter uses to recognise a JSON body (`application/json` or
  `+json`, never a substring match) and the shared default body limit.
- `rawBodyRouteMatcher(routes, { caseInsensitive })` for routers that match
  paths regardless of case.
- Docs: the `RateLimitKey` docstring no longer claims there is never a shared
  bucket — with no resolvable IP every request shares `unknown` (fail closed).
