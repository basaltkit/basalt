---
"@basaltkit/hono": major
---

Wire-level parity with Fastify and Express (framework audit FA-078, FA-079, FA-080).
Major because several defaults change what a handler receives.

- **Breaking (FA-079):** JSON is recognised by its exact media type —
  `application/json` or a `+json` type, parameters ignored — never by a
  substring. `text/plain; application/json` (CORS-safelisted, sent cross-site
  with no preflight) is no longer parsed as JSON. A malformed JSON body is
  answered `400 BAD_REQUEST` ("Malformed request body.") instead of reaching the
  handler as `body: undefined`.
- **Breaking (FA-080):** a repeated query key is an array (`?a=1&a=2` →
  `['1', '2']`), as on Fastify and Express; it used to keep only the first value.
- **Breaking:** `request.url` is the path and query string (`/items?x=1`), as
  `HttpRequest.url` is documented and as the other adapters report it; it used
  to be the absolute URL (`http://host/items?x=1`). Error reports carry the same.
- **FA-078:** an `sse()` response keeps the headers set before it — CORS,
  security headers, rate-limit counters, `x-request-id`; a cross-origin
  `EventSource` failed its CORS check.
- **FA-078:** new `errorHandler` option (default `true`) installs an
  `app.onError`: an error raised outside a route handler — a failing pre-hook or
  edge route, an unreadable body — gets the neutral JSON envelope and reaches
  `onError`, instead of Hono's plain-text 500 that nobody logged. An
  `HTTPException` from your own Hono middleware keeps its response. Pass
  `errorHandler: false` if you install your own `onError`.
- A failing after-hook is reported (`AFTER_HOOK_FAILED`) and no longer replaces
  the response with a 500.
- `DEFAULT_BODY_LIMIT` is now re-exported from `@basaltkit/http` (same value, 1 MiB).

Migration: send JSON with a JSON media type; read repeated query keys as
`string | string[]` (`z.union([z.string(), z.array(z.string())])`); if you parsed
`request.url` as an absolute URL, build it with `new URL(request.url, base)`.
