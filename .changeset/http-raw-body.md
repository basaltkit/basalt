---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
'@basaltkit/express': minor
'@basaltkit/hono': minor
'@basaltkit/subscriptions': patch
'@basaltkit/drives': patch
---

`rawBody()` — the untouched request bytes, on every adapter (BK-029). **This
also fixes a real bug in `@basaltkit/subscriptions`: apps may be silently
failing Stripe/Paddle/Lemon Squeezy webhook verification today.**

**The problem.** Fastify, Express and Hono all parse `application/json` before a
handler runs, and the neutral layer only left a body unread for `upload()`
routes. But every webhook provider — Stripe, Paddle, Lemon Squeezy, Dropbox,
Microsoft Graph, GitHub — signs *the octets it sent*. `JSON.stringify` of the
parsed object is not an approximation of those octets: different whitespace,
different key order, `1.50` re-printed as `1.5`. Verify against it and **every
genuine delivery fails**.

**New — `@basaltkit/http`: `rawBody(options?)`.** A body marker that works the
way `upload()` does. The adapter leaves the body unread; the pipeline reads it —
after the pre-hooks, enrichers and guards, never before — and hands the handler
a `RawBody`: `bytes` (a `Buffer`, exactly what arrived), `text()` (UTF-8),
`contentType` and `contentLength`. Nothing parses it, this package or the app's
own parsers. `maxBytes` (default 1 MiB) is enforced on the declared
`Content-Length` when there is one and on the bytes actually received when there
is not; past it, `413`. A body the route never got to read is drained and the
response carries `Connection: close`, so nothing hangs. When a request *declared*
bytes (a `Content-Length` above zero, or a `Transfer-Encoding`) and none can be
obtained, the route answers `500 RAW_BODY_UNAVAILABLE` — a deliberate refusal,
never a reconstruction. A request that declared **no** body has an empty one: a
zero-length `Buffer`, which is a fact about the request rather than a guess about
a message, and the shape several providers validate a webhook URL with. In OpenAPI the request body is published as opaque bytes
(`*/*`, `format: binary`). Also exported: `isRawBody`, `rawBodyOptionsOf`,
`rawBodyRouteMatcher`, `DEFAULT_RAW_BODY_MAX_BYTES`, and `HttpRequest.bodyBytes`
for adapters that cannot leave a body unread.

**All three adapters**, with the per-adapter story stated honestly:

- **`@basaltkit/fastify`** — `rawBody()` routes are mounted in their own
  encapsulated scope whose only content-type parser hands the request stream over
  unread, for any content type. Your own parsers are never removed or overridden:
  the adapter's JSON parser, `@fastify/multipart`, anything you registered keeps
  serving every other route, and a non-JSON body on a JSON route still answers
  `415`. No caveat.
- **`@basaltkit/hono`** — the plugin's bounded pre-read and its pre/after hooks
  step aside for these paths, so the web `Request`'s own stream still carries the
  octets. The route's `maxBytes` bounds it, not `bodyLimit` (the cap must hold
  *after* the guards, not before). No caveat.
- **`@basaltkit/express`** — `expressPlugin` gives `express.json()` and
  `express.urlencoded()` a `type` filter that returns false for `rawBody()` paths
  (body-parser never reads them) plus a `verify` hook keeping the buffer as a
  second line. Both are installed **only** when a `rawBody()` route exists, so an
  app without one is unchanged. **The one residual caveat:** an app you bring
  yourself with `express.json()` already mounted consumes the stream first — add
  `express.json({ verify: captureRawBody })` (newly exported), or the widespread
  `req.rawBody = buffer` convention, which is honoured too. With neither, the
  route answers `500 RAW_BODY_UNAVAILABLE` rather than guessing.

**Bug fix — `@basaltkit/subscriptions`.** `billingWebhookRoute()` fell back to
`JSON.stringify(request.body)` whenever the raw body was absent — which it was,
on every adapter, by default. Against a real Stripe, Paddle or Lemon Squeezy
endpoint that produces a signature mismatch on **every delivery**: an app wired
exactly as documented has been answering `400 BILLING_WEBHOOK_INVALID` to
genuine webhooks, and its subscriptions silently never leave `incomplete`. The
route now declares `rawBody()` and verifies over the bytes that arrived, on all
three adapters, with no wiring. **The fallback is gone, not discouraged**: there
is no path back to a re-serialized body. New: `billingWebhookRoute(gateway,
{ maxBytes })` and `DEFAULT_WEBHOOK_MAX_BYTES` (256 KiB). Nothing to change in
your app except, on Express with an app-supplied `express.json()`, adding
`verify: captureRawBody`.

**`@basaltkit/drives`** — also fixes the POST handshake ordering found against
RFC 0002 Appendix D.5. Microsoft Graph validates a subscription URL with a
**POST carrying `?validationToken=` and no body at all**, sent before the
subscription exists. The route demanded the raw bytes first, so wherever they
could not be produced the handshake was refused and the operator saw
`subscriptionValidationFailed` on `watch()` — pointing at the subscription
rather than at whatever consumed the body. A query-borne challenge is now
answered **before** any bytes are asked for, on one route that handles both
shapes (Dropbox's on GET, Graph's on POST). Everything else stays fail-closed: a
POST that is not a handshake still requires the bytes it was signed over; the
probe never consults a connection (so it cannot say whether one exists) and
never spends a replay token; and it can only ever produce a challenge — a
verification failure falls through to the delivery path, which raises it
properly. The echo keeps `text/plain` + `nosniff` + `no-store` and is now capped
at 256 characters with control and bidi characters stripped, so an
unauthenticated caller cannot make the endpoint reflect an unbounded or hostile
token.

`driveRoutes()`'s notification endpoint now declares
`rawBody({ maxBytes })` instead of probing for bytes across
`request.body` / `request.raw.rawBody` / a Hono context value. The three
documented lines of per-adapter wiring are no longer needed anywhere. The
fail-closed behaviour is unchanged, and `notifications.rawBody` remains as an
explicit override for deployments that terminate the request where the neutral
layer cannot see it. `rawBodyOf()` is renamed `notificationBytes()`.

Tested by a shared adapter-parity suite (`rawBodyParitySuite`) run against all
three adapters: byte-identical JSON, a body whose whitespace and key order no
re-serialisation reproduces, a non-JSON body with bytes that are not text, a
chunked body with no `Content-Length`, the size cap on both the declared and the
received length, guards running before the body is read, and neighbouring JSON
routes left parsed and validated exactly as before.
