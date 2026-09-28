---
"@basaltkit/express": major
---

Wire-level parity with Fastify and Hono (framework audit FA-077, FA-079, FA-080).
Major because several defaults change what a client receives.

- **Breaking (FA-077, security):** a handler that returns a string is served as
  `text/plain; charset=utf-8`. It used to be `text/html` (Express 5's `res.send`
  default), so a handler echoing its input was a reflected XSS on this adapter
  only. A route that really serves HTML must say so — which the bundled UI
  plugins already do: `reply.header('content-type', 'text/html; charset=utf-8').send(html)`.
- **Breaking (FA-079):** JSON is parsed only for `application/json` or a
  structured `+json` type (`application/merge-patch+json`, `application/vnd.api+json`
  — newly accepted), parameters ignored, the same rule on every adapter. An empty
  JSON body is now `undefined` (no body) instead of body-parser's `{}`.
- **Breaking (FA-080):** on the app `expressPlugin` creates, routing is
  case-sensitive and strict (`/Admin` and `/admin/` no longer reach `/admin`),
  as on Fastify and Hono — a path-based pre-hook could otherwise be walked
  around by changing the case. The query parser is pinned to `simple`
  (`?a=1&a=2` → `['1', '2']`, `?c[d]=1` → `{ 'c[d]': '1' }`; Express 5's default
  already, Express 4 used `qs`). An app you pass with `app` keeps its own settings.
- The JSON/form body limit is 1 MiB by default (was body-parser's 100 KiB),
  like the other adapters; set it with the new `bodyLimit` option.
- The error middleware recognises body-parser errors by body-parser's own `type`
  tags only. An SDK error that merely carries a string `type` and a 4xx `status`
  (a payment provider's `invalid_request_error`) is a 500 again, not "400
  Malformed request body".
- After-hooks (metrics, tracing) also run when the client abandons a response
  (`close` without `finish`), and a failing after-hook is reported through
  `onError` (`AFTER_HOOK_FAILED`) instead of becoming an unhandled rejection.
- An `sse()` stream flushes its headers at once, so a stream that starts quiet
  still opens.
- `rawBody()` routes are matched case-insensitively when the app routes that way
  (an app you bring), so `/HOOK` no longer reaches a `/hook` raw route pre-parsed.

Migration: return HTML with an explicit `content-type`; send JSON with a JSON
media type; if you relied on `{}` for an empty JSON body, default it in the
schema (`z.object({…}).default({})`); if you need Express's case-insensitive or
trailing-slash routing, pass your own `app`.
