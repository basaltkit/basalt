# @basaltkit/drives

## 0.2.0

### Minor Changes

- aff3f6a: Drives phase 2a: the first real provider adapter, and the HTTP routes phase 1 deferred.
  
  **New — `@basaltkit/drives-dropbox` 0.1.0 (unpublished).** The Dropbox adapter:
  OAuth with `token_access_type=offline`, PKCE and refresh/revoke;
  `files/list_folder` + `/continue` cursors for both pagination and the change
  feed; `files/get_metadata`; streaming `files/download` with the `Dropbox-API-Arg`
  header (non-ASCII escaped, because the argument travels in an HTTP header);
  single-shot `files/upload` streamed onto the socket; `content_hash` as a
  clearly-labelled `dropboxContentHash` checksum; rate limiting that honours both
  `Retry-After` and Dropbox's own `retry_after` body hint; the full error taxonomy
  mapped onto the contract; and signed webhook verification (`X-Dropbox-Signature`,
  HMAC-SHA256 over the raw body, constant time) including the `GET ?challenge=`
  handshake that arrives before any connection exists.
  
  **`@basaltkit/drives` — the routes, and seven contract changes the first adapter
  forced.** `driveRoutes()` serves the connect flow and one neutral notification
  endpoint over `route()` from `@basaltkit/http`, parity-tested on Fastify,
  Express and Hono. The contract changes:
  
  - `DriveNotificationResult.accountIds` — Dropbox has no per-connection
    subscription and identifies a connection by provider account id.
  - `DriveNotificationOutcome.connections` is now a **list**: one notification can
    concern several connections.
  - A verified notification that matches nothing is `reason: 'unmatched'` with a
    200, not a 400 — a different answer is an oracle for which accounts a
    deployment holds.
  - `DriveProvider.deltaIncludesExisting` — whether `startDelta`'s cursor replays
    what already exists. Defaults to `false`, so the engine backfills with a
    listing pass first; without it Google Drive's first sync would import nothing.
  - `DriveChange` removals and `DriveRemoval` carry `externalId` **or** `path`:
    a Dropbox deletion has no id at all.
  - `DriveProvider.retryAfterFromBody` — read a vendor rate-limit hint out of a
    429 body, under a hard read bound.
  - `GuardedRequestInit.body` accepts a `Readable`, streamed and never buffered,
    which is what makes `DriveProvider.upload` implementable.
  - `DriveCursorResetError` (`DRIVE_CURSOR_RESET`) — all three vendors can
    invalidate a stored cursor, and the cursor is persisted, so without a way to
    say so one expiry made every future sync of that connection fail identically
    for ever. `syncConnection` drops the cursor and reports `reset: true`.
  
  Also: `DRIVE_ACCESS_DENIED`, `DRIVE_ITEM_NOT_FOUND` and `DRIVE_PROVIDER_ERROR`
  (the one `DRIVE_` code whose retryability the adapter decides), and a fix — the
  reactive refresh on a provider 401 that `Drives.run` documented but never
  performed, so a rejected-but-unexpired token failed the call outright.
  
  ### Upgrading `@basaltkit/drives` from 0.1.x
  
  Three shapes changed. Everything else compiles unchanged — the optional members
  above are additive, and an adapter that declares none of them keeps its 0.1
  behaviour.
  
  1. **`DriveNotificationOutcome.connection` → `connections` (a list).** Replace
     `if (outcome.connection) await sync(outcome.connection)` with
     `for (const c of outcome.connections) await sync(c)`. `connections` is always
     present and is `[]` when nothing matched, so a half-migrated call site reads
     a field that no longer exists instead of failing loudly — grep for
     `.connection` on an outcome.
  2. **A verified-but-unmatched notification returns instead of throwing.** A
     `try/catch` around `handleNotification` that mapped the old
     `DriveNotificationInvalidError` to a `400` no longer fires for it; check
     `outcome.reason === 'unmatched'`. A notification that cannot be *trusted* —
     bad signature, missing channel secret, a body that is not a notification —
     still throws the same error. Apps on `driveRoutes()` need no change.
  3. **`DriveRemoval.externalId` is optional.** A removal may now carry `path` and
     no `externalId` (and hence no `targetId`). An `onRemoved` that used
     `externalId` unconditionally needs a guard; on Google and Microsoft the value
     is still always there, only the type widened.
  
  The same migration is in the package README and in the drives guide (EN and PT).
  
  Both packages stay unpublished until the adapter is validated against a real
  Dropbox app.
- aff3f6a: Drives phase 2c: the OneDrive / SharePoint adapter, and the three contract
  changes Microsoft forced.
  
  **New — `@basaltkit/drives-microsoft` 0.1.0 (unpublished).** The Microsoft Graph
  adapter: Entra ID OAuth with PKCE, `offline_access` and **rotating** refresh
  tokens, against the `common`/`organizations`/`consumers` endpoints or one
  specific tenant; `/children` listings paging on `@odata.nextLink`; `/delta` as
  both backfill and change feed (`deltaIncludesExisting: true`), finishing on
  `@odata.deltaLink` and answering `410 resyncRequired` with
  `DRIVE_CURSOR_RESET`; streaming downloads through the pre-signed
  `@microsoft.graph.downloadUrl`, fetched **unauthenticated** and never allowed
  into an item, a listing, a log or an error; simple uploads streamed onto the
  socket up to Graph's 4 MB ceiling and refused up front above it; `quickXorHash`
  / `sha256` / `sha1` checksums labelled by what the account type actually
  publishes; Graph subscriptions authenticated by the engine's `clientState`, with
  `expiresAt` surfaced for app-side renewal; and an explicit `rootId` grammar
  (`microsoftRoot()`) so a connection says out loud whether it means a personal
  OneDrive, a specific drive or a SharePoint site's document library.
  
  Graph has **no per-application revocation endpoint**, so `revoke` is omitted and
  `disconnect` reports `revoked: false` — documented plainly, because "disconnect"
  then means less on OneDrive than elsewhere: the grant may still be live until the
  user removes consent in their account portal.
  
  **`@basaltkit/drives` — three changes, all of them places the contract was right
  for the first two vendors and wrong for the third:**
  
  - **`DriveNotificationResult.secrets`.** One Graph delivery can batch entries for
    several subscriptions that share a notification URL — two connections behind
    one route is the ordinary case. With a single `secret` the engine synced one
    connection and left the rest stale, which is the failure `accountIds` and
    `DriveNotificationOutcome.connections` were added for in phase 2a, arriving
    from the other direction. An adapter sets `secret` for an ordinary delivery
    and `secrets` for a batch; the matcher accepts either.
  - **`DriveRefreshInput.scopes`.** Microsoft wants a refresh request's `scope` to
    be a subset of the original grant's, and the input carried only the refresh
    token — so an adapter could only send its own defaults, quietly narrowing a
    connection that had consented to `Sites.Read.All` down to `Files.Read`. It
    keeps working until the first SharePoint call, which then fails as a
    permissions problem a long way from the cause. The connection already stores
    its granted scopes; the engine now passes them. Dropbox and Google ignore it.
  - **The guarded fetch no longer forwards credentials across a cross-host
    redirect** (bug fix). `createDriveFetch` re-validated every hop but reused the
    request headers unchanged, so an `Authorization` header followed a `302` to
    another host. Graph's `/content` redirects to a SharePoint or `1drv.com` CDN
    and Google Drive's download redirects to `googleusercontent.com`: in both
    cases a provider-wide bearer token was being presented to a host that already
    holds a narrow pre-signed URL and needs nothing. `authorization`, `cookie` and
    `proxy-authorization` are now dropped when the redirect changes host. The
    allowlist bounds which hosts a redirect may reach; it never made them entitled
    to the token.
  
  `@basaltkit/drives-microsoft` stays unpublished until the adapter is validated
  against a real Entra ID app registration.
- aff3f6a: Drives phase-2 audit: one credential leak, one silent data-loss bug, and three
  places the contract was less honest than the adapters.
  
  **A provider download URL could reach an error, a log and the audit trail
  (security).** `createDriveFetch` let `@basaltkit/webhooks`' `WebhookUrlBlockedError`
  propagate, and that error's message is `Refusing to deliver webhook to <the full
  URL>: <reason>` — correct for an endpoint an operator configured, wrong here.
  On the download path the URL being validated *is* a bearer credential for the
  file (`@microsoft.graph.downloadUrl`, Google's signed `googleusercontent.com`
  redirect target), and `syncConnection` forwards `error.message` verbatim into
  `drive:sync_failed`, which is exactly what apps route to their logger and to
  `@basaltkit/audit`. It needed no attacker: a DNS hiccup on the CDN host was
  enough, on a path that runs for every single download. The guarded fetch now
  re-raises every URL-validation failure as `DriveHostNotAllowedError`, which
  carries the **host and a fixed reason and never the URL** — and no `cause`,
  because a cause chain puts the message straight back into anything that
  serialises the error. `new URL()` failures are wrapped too (`ERR_INVALID_URL`
  carries the offending string on `error.input`). `DriveHostNotAllowedError` takes
  an optional `reason`, so a refusal still says whether it was the allowlist, the
  address or the parse.
  
  **A first sync bigger than one run's ceiling imported nothing past it
  (correctness).** For an adapter with `deltaIncludesExisting: false` — Google,
  the vendor with the largest corpora — a truncated backfill cleared the cursor,
  and the listing page cursor was local to the run. Every subsequent run therefore
  re-walked the same first page, reported `truncated: true` as though it were
  making progress, never imported anything beyond `maxItems`/`maxPages`, and never
  reached the change feed. `syncConnection` now parks its own resume point in
  `connection.cursor` and continues the enumeration across runs, adopting the
  delta cursor only once the walk has actually finished. The resume point holds
  the delta cursor taken **before the first** listing page, so the at-least-once
  argument survives resumption; an unreadable one is recognised by its prefix and
  restarts the walk rather than falling through to the feed.
  
  **`drive:disconnected` now says what happened, not just whether it happened.**
  The payload gains `revocation: 'revoked' | 'skipped' | 'unsupported' | 'failed'`
  (`revoked: boolean` is unchanged). `revoked: false` meant three things at once:
  the caller asked for a local-only disconnect, the adapter has no revocation
  endpoint and never will (Microsoft Graph), or we asked and the provider did not
  answer. Only the last is worth retrying, and only the middle one warrants
  sending the user to a consent portal — which is what the guide's own example
  did, unconditionally. RFC 0002 §D.3.1 identified this ambiguity and left it
  documented on the grounds that a third connection *status* would carry one
  vendor's absence into every adapter; that reasoning is sound and does not apply
  to a hook payload the engine fills in from facts it already has. No adapter
  changes.
  
  **Contract documentation, where a reader actually hits it** rather than in an
  RFC appendix: `DriveChecksum` now states that a checksum is comparable within
  one provider and on Microsoft only within one account type, and absent entirely
  for Google-native documents; `DriveProvider.upload` and `DriveUploadInput` now
  carry the per-adapter ceilings (4 MB / 5 MB / 150 MB) and explain that supplying
  `size` is what moves the refusal from mid-stream to up front; and
  `DriveProvider.verifyNotification` now states that "verified" is a real HMAC
  over the raw body on Dropbox and a secret we chose on Google and Microsoft,
  which sign nothing — and that what makes the weaker two acceptable is the blast
  radius, not the secret. The guide and README carry the same three, plus a
  correction: they claimed a truncated run "resumes exactly where it stopped",
  which was never true of a plain listing and is now true of a backfill.
  
  Tests: `tests/audit-phase2.test.ts` — the leak (4), backfill resumption (4),
  revocation outcomes (4), and the cross-host credential stripping that phase 2c
  shipped without any coverage at all (2). `FakeDriveProvider` gains
  `failNextListWith` to drive a failure the engine did not create.
- d552b84: New package: `@basaltkit/drives` — connect a tenant's external file-storage
  accounts (Google Drive, OneDrive/SharePoint, Dropbox) and import documents from
  them.
  
  This is phase 1 of RFC 0002: the provider-neutral contract plus everything
  generic above it. Vendor adapters ship as satellites (`drives-google`,
  `drives-microsoft`, `drives-dropbox`) in a later phase.
  
  - **Connections** — many per tenant per provider ("Drive Finance", "Drive HR"),
    each with its own label, root, credentials and sync cursor.
  - **Credentials** — AES-256-GCM at rest, bound by AAD to
    `(tenant, connection, provider)` so a ciphertext cannot be moved between rows;
    a key ring makes rotation a rolling change; refresh is proactive and
    single-flight, rotation is persisted, and a lost rotation race no longer
    condemns a healthy connection.
  - **Listing and download** — provider-agnostic cursor pagination; downloads
    stream into `@basaltkit/files` via `putStream` and are never buffered.
  - **Sync** — incremental on the provider's delta token or cursor, with a full
    listing fallback; discovers and enqueues, never downloads, so an HTTP request
    cannot block on a drive of any size.
  - **Dedup** — keyed by `(tenant, connection, externalId)` and checked before the
    download, so an unchanged file costs a local read rather than its size in
    egress.
  - **Security** — `https:` by default, per-provider host allowlist re-checked
    after every redirect, SSRF validation with IP pinning (reusing
    `@basaltkit/webhooks`' guard), mid-stream byte caps, no transparent
    decompression, whole-exchange timeouts, constant-time notification-secret
    comparison, and no token in any log, error, hook payload or audit entry.
  - **Testing** — `@basaltkit/drives/testing` ships `FakeDriveProvider`, which can
    provoke every behaviour the engine handles without touching the network.
  
  Adapter-agnostic: the package registers no routes yet, and the notification
  helpers work on any `@basaltkit/http` adapter.

### Patch Changes

- aff3f6a: Drives phase 2b: `@basaltkit/drives-google`, the Google Drive adapter.
  
  **New — `@basaltkit/drives-google` 0.1.0 (unpublished).** OAuth with
  `access_type=offline`, `prompt=consent` and PKCE, plus refresh and grant
  revocation; `files.list` pagination that **walks a scoped folder's subtree**
  (Drive has no recursive query, and a top-level-only backfill would silently miss
  most of a tenant's documents); `files.get`; streaming `files.get?alt=media`
  through the `302` to `*.googleusercontent.com`; a streamed multipart upload under
  Google's 5 MB simple-upload ceiling; `changes.getStartPageToken` +
  `changes.list` for incremental sync; `changes.watch` / `channels.stop` with the
  engine's per-subscription secret; and `md5Checksum` surfaced honestly as
  `{ algorithm: 'md5' }`.
  
  Four Google behaviours the contract had to be checked against, all of which it
  already expressed:
  
  - **`deltaIncludesExisting: false`.** `changes.getStartPageToken` means "from now
    on", so the engine backfills with a listing pass first. Declaring it the other
    way makes a connection's first sync report success and import **nothing** — a
    test makes that mistake on purpose and asserts the silence.
  - **A throttle is a `403`, not a `429`**, with the reason in
    `error.errors[].reason`. The adapter raises `DRIVE_RATE_LIMITED` for the
    `usageLimits` family and keeps `DRIVE_ACCESS_DENIED` for a genuine permission
    refusal — mapping by status code alone would make every throttle terminal.
  - **`changes.list` is account-wide.** A connection confined to a `rootId` filters
    client-side by walking ancestry, with a per-call cache and a hard lookup
    budget; out-of-scope changes are dropped before they become a `DriveChange`, so
    another folder's metadata never reaches `onRemoved`, the hooks or the ledger.
    A hard deletion (`{fileId, removed: true}`, no file resource) cannot be scoped
    at all and is dropped by default, with `includeUnscopedRemovals` as the opt-in.
  - **Google-native documents have no bytes.** Docs/Sheets/Slides surface with
    `exportOnly: true`; `download` refuses them rather than exporting to a format
    the app never asked for.
  
  **`@basaltkit/drives` — one behaviour fix, no contract change.** `importItem`
  now skips an `exportOnly` item under the `copy` strategy with
  `reason: 'no-content'`, the skip reason phase 1 declared and nothing ever
  emitted. Without it every Google Doc in a tenant's drive becomes a permanently
  failing import job, re-enqueued by every sync because a failure never reaches the
  ledger. `reference` is unaffected: nothing is downloaded there, so a sink that
  wants to run its own export still sees the item.
  
  The adapter stays unpublished until it has been validated against a real Google
  Cloud project.
- aff3f6a: `rawBody()` — the untouched request bytes, on every adapter (BK-029). **This
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
- Updated dependencies [aff3f6a]
  - @basaltkit/http@2.5.0
