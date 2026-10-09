# @basaltkit/drives

## 0.4.0

### Minor Changes

- 5351734: Connection health: `DriveConnection` / `DriveConnectionView` gain optional `lastSucceededAt`, `lastFailedAt` and `lastErrorCode` (an error code, never a message). They are stamped by a sync that persisted a page, by a failed sync (a best-effort compare-and-set against the run's own revision, skipped for an abort), by the refresh that marks a grant invalid (inside the same compare-and-set write), and by the new `drives.check(connectionId, { tenantId })` probe, which lists one item at the root and returns `{ ok, code? }`. No write is added to ordinary successful calls.
  
  Opt-in per store: `DriveConnectionStore` gains an optional `persistsHealth` flag, and the engine puts the three keys in an `update()` patch only when it is `true` (`MemoryDriveConnectionStore` sets it). An existing durable store keeps working unchanged after the upgrade: it never receives the new keys, its connections report no health, and `check()` still returns its answer without writing. To enable health on a durable store, add the three nullable columns and migrate first, then set `persistsHealth = true` — a store that spreads the patch onto Prisma would otherwise fail with `Unknown argument`. The contract suite (`runDriveStoreContract`) checks the round-trip only for a store that declares the flag.
- a32981d: `disconnect()` now emits a `drive:disconnecting` hook before anything is revoked or deleted, while the row still exists. A throwing handler vetoes the disconnect (no revoke, row kept, error propagated); `disconnect(id, { force: true })` proceeds anyway and reports the handler's error to the new `onHookError` option (`process.emitWarning` by default). The fixed order — disconnecting → revoke → unwatch → delete → disconnected — is now documented.
- e2b8d16: Per-call listing mode: `DriveListOptions.recursive?: boolean` (`listItems(id, { recursive })`). `true` lists the subtree, `false` a folder's direct children; omitted, each adapter keeps its constructor default exactly as before. Google honours both (`recursive: false` on an unscoped connection lists the account root's children), Dropbox passes it to `list_folder`, and Microsoft — which has no recursive listing — refuses `recursive: true` with `DRIVE_UNSUPPORTED` (`recursiveList`) instead of silently returning one level. An explicit mode is bound into the engine's page cursor (new `bkl2` envelope; default-mode cursors keep `bkl1`): a continuation that omits `recursive` keeps the cursor's mode, one that changes it is refused.
- 6d966c1: Provider error explanations are no longer thrown away. `DriveProviderError`, `DriveAccessDeniedError` and `DriveCredentialsInvalidError` accept an optional `{ providerMessage }`, carried only on the non-enumerable, log-only `internalDetails` channel (read by `@basaltkit/http`'s error reporter and `internalDetailsOf()`), never in `message`, `details`, hook payloads or the response body. The adapters fill it from allow-listed fields only — Google/Graph `error.message` / `error_description`, Dropbox `user_message.text`, a `missing_scope` error's `required_scope`, or a Dropbox `400 text/plain` body — through the new `providerMessageOf()` helper, which strips control/bidi characters, redacts URL/bearer/JWT/token-shaped text and truncates to 500 characters.
- 16069ab: Add `drives.rotateSecrets({ tenantIds? })`, which re-seals every stored credential still on a retired key (including dormant connections that never refresh) with a compare-and-set per row, and returns `{ resealed, skippedConflicts, remainingOnOldKeys }`. Tenant ids come from the app — the store contract gains no cross-tenant listing. The docs now warn that a tenant id is bound into every sealed secret and must never be renamed, and describe the full key-rotation runbook.
- 6a76048: Add `runDriveStoreContract()` on the test-only `@basaltkit/drives/testing` subpath: a runner-agnostic conformance suite for a durable `DriveConnectionStore` / `DriveImportLedger` (compare-and-set on `expectedRevision`, revision bump, `undefined` clears a column, tenant isolation, ledger idempotency). The docs no longer reference the non-existent `prismaDriveConnectionStore` / `prismaDriveImportLedger` factories; a new "Writing a durable store" guide section shows a Prisma reference implementation instead.

### Patch Changes

- 7a3fd88: BK-027: one AEAD for secrets at rest. `@basaltkit/core/secret-box` (a new subpath, not re-exported from the main entry) exports `createSecretBox({ keys, info, version, aadFields })` — AES-256-GCM with HKDF-SHA256 keys from a key ring, AAD binding to ordered context fields, no plaintext path — and `SecretBoxError`.
  
  `@basaltkit/auth`'s `SecretBox` (`bka2`) and `@basaltkit/drives`' `DriveSecretBox` (`bkd1`) are now thin wrappers over it. Their public APIs, error classes and codes are unchanged, and existing ciphertexts stay byte-compatible (pinned by golden vectors sealed with the previous implementations). One hardening in drives: `DriveSecretBox.reseal` now authenticates an envelope already on the active key before returning `null`, as auth's box always did, so a tampered current blob is reported instead of vouched for.
- 870075a: `createDriveFetch` is now a thin wrapper over `@basaltkit/webhooks`' public `createGuardedFetch` (no behaviour change: same allowlist, SSRF guard, pinning, redirect, cap, timeout and rate-limit handling, same `DRIVE_*` errors). `GuardedResponse` gains `arrayBuffer()`; `hostAllowed` is re-exported from `@basaltkit/webhooks`.
- 3740447: Document that `driveRoutes()` needs the adapter's `@basaltkit/http` at 2.7.1 or later (the cross-copy `rawBody()` marker fix), and that mounting it without `notifications` gives a connect-only setup.
- Updated dependencies [0353877]
- Updated dependencies [7a3fd88]
- Updated dependencies [eeb90bb]
- Updated dependencies [e600b0a]
- Updated dependencies [e74b21b]
- Updated dependencies [3ce3446]
- Updated dependencies [f029638]
- Updated dependencies [3740447]
- Updated dependencies [8b76628]
- Updated dependencies [36b800c]
- Updated dependencies [500edef]
- Updated dependencies [870075a]
- Updated dependencies [194931a]
- Updated dependencies [1868e07]
- Updated dependencies [bbb8463]
  - @basaltkit/http@2.8.0
  - @basaltkit/core@1.6.0
  - @basaltkit/webhooks@4.1.0

## 0.3.1

### Patch Changes

- Updated dependencies [b7171e5]
- Updated dependencies [b7171e5]
  - @basaltkit/http@2.7.0
  - @basaltkit/webhooks@4.0.0

## 0.3.0

### Minor Changes

- e53db52: Framework audit, pass 2, section E (FA-072..FA-076): drives hardening.
  
  **`@basaltkit/drives` (0.x — minor is the breaking slot)**
  
  - **Signed listing cursors (FA-072/FA-073).** `listItems()` now returns `bkl1.<adapter cursor>.<mac>`, MAC-bound (key derived from `secret`) to the tenant and connection, and refuses any other cursor with `DRIVE_ACCESS_DENIED` before the adapter sees it. A Graph cursor is a URL fetched with the connection's bearer token, so a caller-authored one could read another drive. *Migration:* pass cursors back unchanged; a cursor issued before the upgrade or under a rotated `secret` must be dropped (list again from the start). Stored sync cursors are unaffected.
  - **Refresh race (FA-074).** A worker told `invalid_grant` now invalidates only by compare-and-set, and only if the row still holds the rejected refresh token (otherwise it adopts the newer credentials); a winner that finds itself invalidated by such a loser restores the connection with its fresh tokens. No API change.
  - **Per-provider replay keys (FA-075).** The replay guard no longer reads `x-goog-message-number` from every provider; it keys on the new optional `DriveNotificationResult.replayKey` or a digest of the raw body. *Migration (custom adapters):* report `replayKey` if your vendor's body does not distinguish deliveries.
  - **FA-076.** `DriveSecretBox` pins a 16-byte GCM tag (truncated tags refused) and rejects NUL in the AAD context; watch secrets are stored as a `sha256:` digest (legacy plain rows still match); `timeoutMs` is documented as an inactivity timeout and now also bounds each wait for response headers, with a new opt-in whole-exchange `deadlineMs` (`DrivesOptions`, `DriveFetchOptions`, `GuardedRequestInit`); the OAuth callback echoes only a well-formed `?error=` code; the anonymous notification route answers an unknown provider with `DRIVE_NOTIFICATION_INVALID` instead of listing registered providers.
  
  **Adapters (major: `rootId` confinement now refuses calls that used to succeed)**
  
  - **Root confinement (FA-073).** With a `rootId`, a `folderId`, `getItem`, `download` and an upload target outside the root are refused with `DRIVE_ACCESS_DENIED` (`get` returns `null`). Google walks `parents` (resolving the `root` alias); Microsoft walks `parentReference.id` for an `item:` root (new `ancestryMaxDepth` option); Dropbox compares `path_lower` (lexically for paths, one `get_metadata` for `id:`/`ns:`, the download's `Dropbox-API-Result` before its body is read). *Migration:* a connection that relied on reaching outside its root must be reconnected with a wider root (or none).
  - `@basaltkit/drives-google` reports `X-Goog-Message-Number` as `replayKey`. Requires `@basaltkit/drives` ≥ 0.3.
- e54b7b1: The single-tenant store key is a reserved sentinel (framework audit, FA-030 — same fix as `@basaltkit/files`).
  
  `SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so in an app without `@basaltkit/tenancy` a request carrying a tenant named `default` could `list` the app's drive connections, read and import through them, and `disconnect` them. `@` is outside the tenant-id grammar, and a context or explicit tenant equal to the sentinel is refused with the new `DriveTenantReservedError` (`DRIVE_TENANT_RESERVED`, 400).
  
  The sentinel surfaces as `connection.tenantId`, but it is a store key, not a tenant id: in a single-tenant app leave `tenantId` out of calls instead of passing it back. The engine does so internally (`completeAuthorization` → `connect`, `importItem` → `download`), and `filesSink` no longer forwards it to `@basaltkit/files` — before, a single-tenant import uploaded under the tenant `'default'` rather than the files single-tenant key.
  
  **Breaking (0.x minor) — migration:** a single-tenant app with persisted connections must re-key them once. Plain SQL is not enough: each `secret` is sealed with its `tenantId` as AES-GCM associated data, so re-seal it with the same key ring `Drives` uses:
  
  ```ts
  import { DriveSecretBox, SINGLE_TENANT_SCOPE } from '@basaltkit/drives'
  
  const box = new DriveSecretBox(keys)
  for (const row of await db.driveConnection.findMany({ where: { tenantId: 'default' } })) {
    const context = { connectionId: row.id, provider: row.provider }
    const plain = box.open(row.secret, { ...context, tenantId: 'default' })
    const secret = box.seal(plain, { ...context, tenantId: SINGLE_TENANT_SCOPE })
    await db.driveConnection.update({ where: { id: row.id }, data: { tenantId: SINGLE_TENANT_SCOPE, secret } })
  }
  ```
  
  then move the import ledger (`UPDATE <ledger table> SET "tenantId" = '@single' WHERE "tenantId" = 'default'`). Skip it if `default` was ever a real tenant in that database. An authorization started before the upgrade fails its callback once (its `state` names the old key). No legacy fallback read is kept on purpose: it would re-open the collision in the other direction.

### Patch Changes

- e54b7b1: 502 errors no longer echo upstream detail to HTTP clients (framework audit, FA-041 follow-up).
  
  - `OAuthExchangeError` (`AUTH_OAUTH_EXCHANGE_FAILED`) quoted the provider's reply — `error_description`, an HTTP status, the discovery URL. It now sets `expose = false`: the client gets the code and `Bad gateway.`, the log keeps the full message.
  - `DriveHostNotAllowedError` (`DRIVE_HOST_NOT_ALLOWED`) named the host it refused to reach and why, which made every download route an oracle for internal host names. Same treatment; the message and `details` still reach the log, `drive:sync_failed` and the audit trail unchanged.
  
  Requires `@basaltkit/http` with `expose = false` support (same release).
- Updated dependencies [e54b7b1]
- Updated dependencies [e54b7b1]
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/core@1.5.0
  - @basaltkit/http@2.6.0
  - @basaltkit/webhooks@3.0.0

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
