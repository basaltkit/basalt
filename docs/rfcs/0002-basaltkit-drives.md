# RFC 0002 — `@basaltkit/drives`: connecting a tenant's external file-storage accounts

- **Status:** Draft (phase 1 implemented — core abstraction + fake provider; provider adapters pending maintainer approval)
- **Author:** basalt-principal-architect
- **Date:** 2026-09-20
- **Affects:** a new `@basaltkit/drives`; composes `@basaltkit/files`, `@basaltkit/storage`, `@basaltkit/webhooks`, `@basaltkit/queue`, `@basaltkit/scheduler`, `@basaltkit/audit`; proposes a promotion out of `@basaltkit/auth`
- **Non-negotiables honoured:** adapter-agnostic HTTP; DI via tokens, no decorators; tenancy is data-layer, not route-layer; secure-by-default and fail-closed; the AI/codegen layer is untouched and remains dev-only

---

## 0. TL;DR

Apps want to import documents from a tenant's **Google Drive, OneDrive/SharePoint
or Dropbox**. Almost none of that problem is provider-specific. What is generic —
and what every app would otherwise rebuild badly — is: multiple connections per
tenant per provider, OAuth credentials encrypted at rest with refresh and
rotation, provider-agnostic pagination, streaming download that never buffers,
incremental sync on a cursor, dedup, rate-limit backoff, and an unauthenticated
webhook endpoint that must not become a cross-tenant oracle.

This RFC proposes **one new package, `@basaltkit/drives`**, holding the
provider-neutral contract and everything generic above it, with vendor adapters
as satellites (`drives-google`, `drives-microsoft`, `drives-dropbox`) in phase 2.
Phase 1 — the contract, the engine, a full fake provider, 231 tests and the docs
— is implemented in this change.

Three decisions carry the design:

1. **An adapter never sees a refresh token and never calls `fetch`.** It is
   handed a `DriveSession` with one short-lived access token and a guarded fetch
   that is host-allowlisted, SSRF-validated and IP-pinned. This makes a
   third-party adapter a small, low-trust component rather than a place where a
   bug leaks a tenant's long-lived credential.
2. **Sync discovers; the queue downloads.** `syncConnection` walks the change
   feed and enqueues; it never opens a byte. An HTTP request therefore cannot
   block on a drive of any size.
3. **The framework stops at provenance.** It brings bytes across safely and
   records what it brought. Quarantine policy, OCR, classification and business
   meaning are the app's — see §7.

---

## 1. Scope & goals

**Goals**

1. One provider-neutral contract that Google Drive, OneDrive/SharePoint and
   Dropbox can each satisfy without the engine knowing which is which.
2. Many connections of the same provider per tenant ("Drive Finance", "Drive
   HR"), each with its own credentials, root and sync cursor.
3. Credentials encrypted at rest, refreshed with single-flight, rotated safely,
   and never present in a log, an error, a hook payload or an audit entry.
4. Tenant isolation enforced in the **data layer**, so a forgotten scope check
   in a route cannot leak.
5. Import that streams into `@basaltkit/files` without buffering, and dedups so
   an unchanged file costs a local read rather than its size in egress.
6. A hostile-surface posture throughout: SSRF, oversized bodies, MIME spoofing,
   webhook spoofing and replay, abusive retries.

**Non-goals**

- Shipping the vendor adapters in this phase (§9).
- HTTP routes in this phase (§6.4) — their shape is constrained by vendor
  handshakes this phase could not verify against a live provider.
- Anything about what a document *means* (§7).

---

## A. Current-state review — what already exists, and what it does not cover

Read before designing. Every claim below is from the source in this repository.

### A.1 `@basaltkit/storage` 3.x — sufficient, and already the right shape

`Disk` (`packages/storage/src/index.ts:320`) has `putStream`, `getStream`,
`copy`, `stat`, `temporaryUrl` and `temporaryUploadUrl`, with the driver
contract in `packages/storage/src/driver.ts`. `putStream` is documented to
enforce `maxBytes` mid-stream and destroy the source past the cap.

**Conclusion:** nothing to add. An import streams into storage *through*
`@basaltkit/files`, never directly.

### A.2 `@basaltkit/files` 4.x — the right landing zone, and the reason not to duplicate

`Files.upload(content, input)` (`packages/files/src/files.ts:313`) accepts a
`Uint8Array`, an `AsyncIterable` or a web `ReadableStream`, and on a driver with
`putStream` writes straight through while it size-checks, SHA-256-hashes and —
with `validate.sniff` — type-sniffs the first 64 KiB, rejecting bytes that
contradict the declared type (`FileTypeMismatchError`). It enforces a per-tenant
quota and supports `requireScan` quarantine.

**Conclusion:** an imported file must get **exactly** the treatment an uploaded
one gets. The brief's MIME-spoofing requirement is therefore satisfied by
composition, not by new code: `filesSink` hands the provider stream to
`Files.upload` and the existing sniffer decides the real type. Duplicating that
pipeline would have been the single worst outcome of this work.

`FileStore` (`packages/files/src/store.ts:59`) takes `tenantId` as an explicit
first argument on every method. This RFC copies that shape exactly.

### A.3 `@basaltkit/auth` 3.x — the OAuth client is **not** reusable here

This was the most important thing to get right, so it was read rather than
assumed.

`OAuth.callback()` (`packages/auth/src/oauth.ts:309`) verifies a signed,
single-use `state` bound to a browser cookie, exchanges the code with a PKCE
verifier, fetches the profile and calls `auth.socialLogin(...)`. Its
`exchangeCode` returns `{ accessToken, idToken }` — **the refresh token is
discarded**. There is no `offline_access`, no refresh grant, and no persistence.

That is correct for what it is: a login client proves *who you are* once, and a
session takes over. This package needs the opposite — a durable, per-tenant
grant to act on a user's files for months, with rotation and revocation.
Reusing it would mean changing the return type of a security-critical public
API (a breaking change) and giving it a credential-storage responsibility it
should not have.

**Decision: do not reuse it. Do reuse its reasoning** — signed, expiring,
single-use state bound to an `HttpOnly` cookie, PKCE S256 derived from the same
binding, timing-safe comparison. `DriveAuthorizationFlow` re-derives that
pattern and adds a tenant claim to the state, so a state cannot be replayed
into another tenant. §8.1 proposes extracting the shared core so there is
eventually one implementation.

### A.4 `@basaltkit/auth`'s secret box — cannot be reused, and should not be copied

`packages/auth/src/secret-box.ts` is AES-256-GCM for TOTP secrets. It is
**private**: not exported from `packages/auth/src/index.ts`, no package subpath,
used only by `auth.ts:801`. So it is unreachable without editing
`@basaltkit/auth`.

It is also weaker than a refresh token needs, in three specific ways:

| Property | `auth` secret box | What a refresh token needs |
|---|---|---|
| Associated data | none | bound to `(tenant, connection, provider)` — otherwise a ciphertext lifted into another tenant's row decrypts and hands over their credentials |
| Key rotation | one key, no key id | a key ring, so rotation is rolling rather than a flag day |
| Unknown input | returns it unchanged (legacy plaintext path) | fail closed — whoever can write the column must not be able to choose the plaintext |

**Decision:** implement `DriveSecretBox` with AAD, a key ring and no plaintext
path, and propose promoting it (§8.1). This is the one accepted duplication in
the design; it is deliberately the *stronger* of the two so the merge direction
is unambiguous.

### A.5 `@basaltkit/webhooks` 2.x — the SSRF guard is reusable; the client is not

`packages/webhooks/src/ssrf.ts` exports `resolveAndValidate`, `pinnedLookup`,
`isPrivateIp` and `assertDeliverableUrl`. It classifies IPv4 and IPv6 across
every spelling, resolves once, checks **every** returned address, and returns a
pinned address so the socket cannot be rebound. This is high-quality,
security-critical code, and IP-range classification is the last thing that
should exist twice in a repository.

Its transport (`pinned-fetch.ts`) is **not** reusable: `pinnedRequest` is
internal and destroys the response body — correct for a webhook, useless for a
download.

`WebhookManager` (`packages/webhooks/src/index.ts`) is also the reference for
the tenancy posture this package adopts: ambient tenant wins, explicit
`tenantId` can never widen, results re-filtered after the store returns.

**Decision:** depend on `@basaltkit/webhooks` for the guard primitives; write
the streaming pinned transport here. §8.2 proposes promoting the guard so the
dependency can be dropped.

### A.6 `@basaltkit/queue`, `@basaltkit/scheduler`, `@basaltkit/events`

- `defineJob` (`packages/queue/src/job.ts:77`) with attempts/backoff, and
  `QueueManager.dispatch` snapshots the ALS context (`manager.ts:219`) so a
  worker restores the tenant. Exactly what an import pipeline needs.
- `defineReconciler` (`packages/scheduler/src/reconciler.ts:142`) already solves
  overlap guarding, the cross-replica lease, per-item error isolation and
  `maxPerRun`. A stalled-sync sweep is a `find`/`redispatch` pair, not new code.
- `Outbox` (`packages/events/src/outbox.ts`) exists for transactional enqueue.

**Decision:** compose all three, depend on none of them. The engine takes an
`enqueue` function; the docs show the ten-line `defineJob` wiring. A hard
dependency would buy nothing and would drag a queue into an app that only wants
to list a folder.

### A.7 Event naming — derived from the repo, not from the request

The brief's suggested names were not adopted. Grepping every emission in
`packages/**` shows the shipped convention is the **HookBus** with
`<domain>:<verb>`, colon-separated, snake_case for multi-word verbs:
`auth:login_failed`, `auth:mfa_enabled`, `team:role_changed`, `file:uploaded`,
`billing:trial_expired`, `tenancy:switched`. The dotted `defineEvent('order.created')`
form appears only in examples, never in a shipped package emission.

**Decision:** `drive:connected`, `drive:disconnected`,
`drive:credentials_refreshed`, `drive:credentials_invalid`, `drive:sync_started`,
`drive:sync_completed`, `drive:sync_failed`, `drive:item_imported`,
`drive:item_skipped`. Declared by module augmentation of `BasaltHooks`, as
`filesPlugin` does. `auditPlugin` picks up hook patterns automatically, so an
app adds `'drive:*'` to its `hooks` list and the trail exists.

---

## 2. The load-bearing decision — placement and packaging

### 2.1 Why not inside an existing package

- **Inside `@basaltkit/files`** — would drag OAuth, a credential store, an HTTP
  client and a sync engine into every app that accepts an avatar upload. `files`
  is about bytes a user hands you; this is about an account you act on behalf
  of. Rejected.
- **Inside `@basaltkit/storage`** — `storage` is *your* buckets, addressed by
  key. A third-party drive is not a disk: it has identity, consent, revocation
  and its own change feed. Modelling it as a `StorageDriver` would mean a driver
  that cannot honour `put` reliably, has no stable key space and needs a UI for
  consent. Rejected, and worth stating plainly because it is the superficially
  attractive option.
- **Inside `@basaltkit/auth`** — the OAuth surface looks similar and is not
  (§A.3). Rejected.

### 2.2 Why one package and not three

The credential model, the sync engine and the import pipeline share the
connection record and are meaningless apart. Splitting them would be an
artificial package boundary of the kind this repository's guardrails warn
against. The **store** split is the exception, and it follows the existing house
pattern: the core package defines `DriveConnectionStore` / `DriveImportLedger`
plus in-memory implementations; `@basaltkit/drives-prisma` and `-sqlite` are
phase 3, exactly as `webhooks` / `webhooks-prisma` / `webhooks-sqlite` are
arranged today.

### 2.3 The name

Every package base in this repository is a single word (`files`, `storage`,
`webhooks`, `search`, `exports`, `flags`), with satellites as `<base>-<variant>`
(`search-postgres`, `queue-bullmq`, `storage-s3`). Names considered and rejected:

| Candidate | Why not |
|---|---|
| `files-sources` | mechanically valid, but satellites become `files-sources-google` — a three-segment shape that exists nowhere in the repo |
| `imports` | collides in meaning with the shipped `exports` (data export to xlsx), which is a different thing entirely |
| `connectors` | promises every kind of SaaS connector; this is file storage only |

**`@basaltkit/drives`** — plural, like `files` / `exports` / `flags` /
`comments`; a "cloud drive" is the industry term covering all three targets;
satellites read naturally as `drives-google`, `drives-microsoft`,
`drives-dropbox`. It collides with neither `storage` (our buckets) nor `files`
(our uploads).

---

## 3. The contract

Full source: `packages/drives/src/provider.ts`. The shape, with the reasoning
that is not obvious from the types:

```ts
interface DriveProvider {
  readonly name: string
  readonly allowedHosts: readonly string[]      // the primary SSRF control
  readonly authorization: DriveAuthorization
  list(session, options): Promise<DrivePage<DriveItem>>
  download(session, item): Promise<DriveContent>
  get?(session, externalId): Promise<DriveItem | null>
  upload?(session, input): Promise<DriveItem>
  startDelta?(session, options): Promise<string>
  delta?(session, cursor): Promise<DriveDelta>
  watch?(session, input): Promise<DriveWatch>
  unwatch?(session, watch): Promise<void>
  verifyNotification?(input): DriveNotificationResult   // pure, synchronous
}
```

- **Only `list` and `download` are required.** Everything optional degrades
  honestly: the engine raises `DRIVE_UNSUPPORTED` rather than silently doing
  nothing, and falls back to a full listing when `delta` is absent.
- **`DriveSession` carries one access token, never the refresh token** — plus
  the guarded fetch, the connection id, the tenant id and an `AbortSignal`.
- **Pagination is an opaque cursor**, deliberately not offset/limit: none of the
  three providers offers stable offsets, and an offset over a mutating folder
  silently skips items.
- **`DriveItem.contentType` is explicitly untrusted** — providers echo whatever
  the uploading client declared. The real type is decided by sniffing (§A.2).
- **`DriveItem.externalUrl` is stored and shown, never fetched** — a
  provider-controlled URL used as a request target is an SSRF sink.
- **`verifyNotification` is pure and gets no session** — so hammering the
  webhook route cannot be amplified into provider traffic.

### 3.1 Change detection — what the providers actually offer

Checked per vendor, because the answer decides whether a single opaque cursor is
honest:

| Provider | Mechanism | Cursor |
|---|---|---|
| Google Drive | `changes.getStartPageToken` → `changes.list` | `nextPageToken`, finishing on `newStartPageToken` |
| Microsoft Graph | `/delta` on a drive or folder | `@odata.nextLink`, finishing on `@odata.deltaLink` |
| Dropbox | `files/list_folder` → `files/list_folder/continue` | `cursor` + `has_more` |

All three are resumable opaque tokens. One `string` cursor is therefore a
faithful abstraction, not a lowest common denominator.

### 3.2 Push notifications — what they actually send

| Provider | Handshake | Authentication | Carries the change? |
|---|---|---|---|
| Dropbox | `GET ?challenge=` echo | `X-Dropbox-Signature`, HMAC-SHA256 over the **raw** body | no |
| Microsoft Graph | `POST ?validationToken=`, echoed as `text/plain` | `clientState` we chose | no |
| Google Drive | — | `X-Goog-Channel-Token` we chose | no |

Two consequences drive the design. First, **two of three authenticate with a
secret we generate**, so the engine generates a per-subscription random secret
rather than letting an adapter choose. Second, **none of them sends the changed
data** — which is what bounds the damage of a spoofed notification to a wasted
sync (§5.4).

---

## 4. Multi-tenancy and the credential model

### 4.1 Connections

`DriveConnection` (`packages/drives/src/store.ts`) is keyed by `id` and scoped
by `tenantId`. Nothing is keyed by `(tenantId, provider)` — which is precisely
what makes "Drive Finance" and "Drive HR" fall out of the model rather than
being a special case. Each row has its own `label`, `rootId`, credentials,
`cursor` and `watch`.

`DriveConnectionView` is `DriveConnection` minus `secret` and `watch`. The
facade returns **only** the view, mirroring `WebhookEndpointView`: the surest
way not to leak a secret through a list endpoint is for the secret not to be in
the object the endpoint serialises.

### 4.2 Isolation, in the data layer

Three independent mechanisms, because route-level checks are the ones that get
forgotten:

1. **`tenantId` is an explicit argument on every store method**, so an unscoped
   query is not expressible.
2. **The facade re-filters** everything a store returns against the resolved
   tenant — a custom or buggy store cannot widen a result set. There is a test
   that drives a deliberately leaky store and asserts the listing stays correct.
3. **Anti-widening tenant resolution**: an ambient tenant in the ALS context
   always wins; an explicit `tenantId` is honoured only when it agrees, or when
   there is no context tenant (jobs, CLI). A route that forwards `?tenantId=`
   from the client gets `DRIVE_TENANT_MISMATCH`, not another tenant's data. The
   rules are identical to `resolveFileTenant` in `@basaltkit/files`.

A connection belonging to another tenant produces **404, never 403** — telling a
caller "it exists but is not yours" turns connection ids into an oracle.

### 4.3 Credentials at rest

Envelope: `bkd1.<keyId>.<iv>.<tag>.<ciphertext>`, AES-256-GCM, key derived with
HKDF-SHA256 from the ring entry. AAD binds `(version, keyId, tenantId,
connectionId, provider)`, so a blob moved to another row fails authentication
instead of decrypting. Tested in all three directions (tenant, connection,
provider).

Rotation is rolling: the first key in the ring seals, every other key still
opens. `reseal` moves a row onto the active key when it is next written, and
returns `null` when there is nothing to do.

### 4.4 Refresh, rotation and the race that breaks connections

- **Proactive**: refreshed 60 s before expiry rather than after a 401.
- **Single-flight per connection**: twenty concurrent import jobs perform one
  refresh, not twenty. Against a rotating provider, nineteen of those twenty
  would be attempts to spend an already-retired token.
- **Rotation is persisted**; a provider that omits a new refresh token (Google,
  Dropbox) keeps the existing one, rather than losing it at the next cycle.
- **Optimistic concurrency** via `revision`: a compare-and-set loser does not
  overwrite the winner. It re-reads, and only re-refreshes if the winner's
  tokens are still expired — bounded to three attempts so a collision cannot
  livelock a token endpoint.
- **The rotation race, handled explicitly.** Two workers refreshing at once
  against a rotating provider produce an `invalid_grant` for the loser that is
  *indistinguishable from a revoked grant*. Taking it at face value marks a
  healthy connection `invalid` and logs the tenant out of their own drive, at
  random, under load. Before condemning a connection, the engine re-reads it: if
  another writer stored usable credentials, it adopts them. **This bug was found
  by writing the test, and the test for it is in
  `tests/credentials.test.ts`.**
- **Genuinely invalid credentials fail closed**: the connection is marked
  `invalid`, stops generating provider traffic from every queued job, and emits
  `drive:credentials_invalid`.

---

## 5. Security analysis

Treated as a hostile surface throughout. Each control, and the specific attack
it answers.

### 5.1 SSRF — the primary risk, and why it is bigger here than for webhooks

A webhook target is operator-configured. A drive integration is different in
kind: **the provider's own responses hand us URLs we are then expected to
fetch** — Graph's `@microsoft.graph.downloadUrl`, Google's redirect to
`googleusercontent.com`. A tenant who can place a file in a shared folder
influences what the provider says about it. Those URLs are attacker-influenced
data.

Six layers, all in `packages/drives/src/fetch.ts`:

1. **Host allowlist**, declared per provider, checked **before DNS** and again
   after every redirect. `.suffix` entries match subdomains only — so
   `evilgoogleusercontent.com` is refused where a naive `endsWith` would pass
   it. Tested.
2. **SSRF validation + IP pinning**, delegated to `@basaltkit/webhooks`: private,
   loopback, link-local (`169.254.169.254`), CGNAT, ULA and reserved addresses
   refused; every resolved address checked, not just the first; the socket
   pinned to the validated IP so a DNS rebind cannot swap in an internal address
   at connect time.
3. **`https:` only by default.** Widening is a separate, explicit
   `allowedSchemes` option — deliberately *not* a side effect of
   `allowPrivateHosts`, so cleartext is a decision a reviewer can find.
4. **Manual redirects**, re-validated from scratch at each hop, hop count
   capped, and the request body dropped on redirect.
5. **Byte cap enforced while streaming** — an oversized body is abandoned
   mid-flight, and the source destroyed, so it costs the abandoned prefix rather
   than the whole file.
6. **Whole-exchange timeout**, not connect-only: a provider that accepts the
   connection and then trickles one byte a minute is the cheapest way to pin a
   worker forever.

### 5.2 Decompression bombs

No `accept-encoding` is sent and no `content-encoding` response is inflated, so
the byte cap applies to real bytes on the wire — the only number a bomb cannot
lie about. A caller that genuinely needs compressed transport must handle
inflation itself, under its own cap.

### 5.3 MIME spoofing

Not solved here, on purpose: solved by **composition**. `filesSink` hands the
stream to `Files.upload`, whose `validate.sniff` inspects the first 64 KiB,
rejects bytes that contradict the declared type, records the detected type and
keeps the provider's claim in `metadata.declaredType`. Re-implementing that
would have been duplication of the worst kind.

### 5.4 Webhook spoofing and replay

The notification endpoint is **unauthenticated by construction**. The design
bounds that rather than pretending otherwise:

- **Notifications are never trusted for content.** None of the three vendors
  sends the changed data, so even a perfectly forged notification can only cause
  the app to go and ask the provider, using its own credentials, for its own
  tenant. The blast radius of a spoof is a wasted sync — a design property, not
  luck.
- **A per-subscription random secret** is generated by the engine, handed to the
  provider at subscribe time, and compared in **constant time** on the way back.
- **The candidate connection list is supplied by the caller**, never scanned
  across tenants. An unauthenticated caller cannot address another tenant's
  connection at all; there is no path from this endpoint to a cross-tenant read.
- **Replay** is bounded by design (a repeat costs one near-no-op sync, because
  the cursor has moved) and can be collapsed outright with an optional
  `NotificationReplayGuard`.
- **HMAC verification takes the raw `Buffer`**, never a parsed object — a
  re-serialised body changes the bytes and the signature stops matching for
  reasons nobody can debug.

### 5.5 Token leakage

No token, refresh token or client secret appears in any error message, `details`
payload, hook payload or audit entry. `details` is serialised into HTTP bodies by
`@basaltkit/http` and stored by `@basaltkit/audit`, so it is treated as public.
`drive:sync_failed` carries `error.message` only, never the error object — a
provider download URL is itself a bearer credential. There are explicit tests
asserting that serialised errors and hook payloads contain no token material.

### 5.6 Abusive retries

Only recognisably transient failures retry; everything else — including
`DRIVE_CREDENTIALS_INVALID` and `DRIVE_HOST_NOT_ALLOWED` — is terminal.
Retrying a broken connection is how one tenant gets the **whole application**
throttled by a provider. `Retry-After` wins over our own schedule; full jitter
prevents a fanned-out sync from reconverging into a herd; an absurd
`Retry-After` (over 60 s) fails the job for the queue to re-run rather than
holding a worker hostage.

### 5.7 Consent and revocation

`disconnect` revokes at the provider **by default**. Deleting our row while the
grant lives on does not achieve what "disconnect" means; it only makes the
remaining access invisible to us. A revocation that fails still deletes the
local row and reports `revoked: false`, which is what an operator needs to know.

---

## 6. Design of the generic layer

### 6.1 Import and dedup

`importItem` checks the ledger **before** downloading. For a nightly sync over a
folder that rarely changes, that is the difference between a few kilobytes and
the whole corpus, every night.

Dedup is keyed by `(tenantId, connectionId, externalId)` and compares a content
version: provider revision first, then checksum, then `updatedAt` + size. The
ordering matters — `updatedAt` also moves on a rename or a re-share, and
re-downloading a gigabyte because someone renamed a folder is a bill, not a
feature. An item with no version signal at all is treated as always-changed,
which is the safe direction.

### 6.2 The two storage strategies

| | `copy` | `reference` |
|---|---|---|
| Bytes | downloaded into the app's storage via `@basaltkit/files` | **nothing is downloaded** |
| Availability | survives deletion or un-sharing at the provider | disappears with the original |
| Retention | the app's policy applies | the provider's does |
| Auditability | can prove what the document said | can prove only that it was seen |
| Revocation | revoking the connection leaves the copy | revoking the connection makes it unreachable |
| Cost | storage + egress | zero |
| Data protection | the app becomes a controller of that data | the app holds metadata only |

Both are first-class. `reference` is not a degraded `copy`: for an app that must
not duplicate a client's documents, it is the correct answer, and the engine
guarantees no byte is fetched.

### 6.3 Sync

`syncConnection` uses the change feed when the adapter has one and a paginated
full listing otherwise (still correct, just more metadata reads — the ledger
absorbs the repetition). It **never downloads**; it enqueues. The cursor is
persisted after every page, so a crash costs one page rather than the run, and
`maxItems` / `maxPages` are hard ceilings, not hints: the first sync of a mature
Google Drive can be hundreds of thousands of items, and a loop with no ceiling
is how one tenant's connect request becomes an outage.

Removals are **reported, never acted on**. Whether a deletion at the provider
should delete the app's copy is a retention decision, and retention is a legal
question the framework has no business answering.

`dueConnections` feeds `defineReconciler` for stalled syncs, rather than this
package growing a scheduler.

### 6.4 What is deliberately not in phase 1

**HTTP routes.** The connect flow and the notification endpoint need routes, and
they belong in `@basaltkit/drives` over the neutral `@basaltkit/http` layer so
they work on Fastify, Express and Hono alike. They are deferred because their
shape is constrained by vendor handshakes that could not be verified against a
live provider in this phase: Graph's `validationToken` must be echoed as
`text/plain` within a few seconds, and Dropbox's `GET ?challenge=` arrives before
any subscription exists. `DriveNotificationResult.challenge` is designed to let
one neutral route answer all three, but shipping the route before confirming the
handshakes against real traffic would be guessing in the security-sensitive
direction. Phase 2 lands them with the first adapter.

### 6.5 `@basaltkit/sdk` — no change, and why

Considered and rejected for this phase. The SDK's model is hand-written
`endpoint()` descriptors sharing the server's Zod schemas. With no HTTP routes
in phase 1 there is nothing to describe; and when the routes land, the
descriptors are roughly thirty lines of app-shared Zod that the existing
`endpoint()` already covers with **zero new SDK code**. Adding an SDK surface now
would be an abstraction with no second caller.

---

## 7. What the framework deliberately does not do

The framework brings bytes across safely and records provenance. It has no
opinion about what a document *means*. Specifically out of scope, and the app's:

- **Quarantine policy** — `@basaltkit/files` already has `requireScan` and
  `markScanned`; choosing the scanner and the policy is the app's.
- **OCR, extraction, classification** — domain-specific, and the AI layer of
  this framework is dev-only and never a runtime dependency.
- **Business meaning** — which folder maps to which matter, client or case;
  approval workflow; naming conventions.
- **Retention and deletion on removal** — reported, never decided (§6.3).
- **Which files to import** — a `filter` hook, not a framework policy.

The seam is `DriveSink`: one function, whatever the app wants on the other side.

---

## 8. Maturity proposals for the rest of the framework

Both are filed as backlog entries; neither is done in this change, because both
touch packages owned elsewhere.

### 8.1 Promote a hardened secret box, and migrate `@basaltkit/auth`

`DriveSecretBox` is the second AES-256-GCM implementation in the repository
(§A.4). The right end state is one primitive in a lower layer, with AAD, a key
ring and fail-closed decryption, consumed by `auth` (MFA secrets), `drives`
(OAuth tokens), and any future package holding a third-party credential.
Proposed as **BK-027**.

### 8.2 Promote the SSRF guard and an outbound HTTP policy

`resolveAndValidate` / `pinnedLookup` are excellent and live in a package about
webhook *subscriptions*. Any package making outbound calls to a URL it did not
choose needs them, and `@basaltkit/drives` now depends on `@basaltkit/webhooks`
purely for that. A shared guarded, streaming, capped, pinned HTTP client belongs
lower. Proposed as **BK-028**.

---

## 9. Phased plan

| Phase | Deliverable | Status |
|---|---|---|
| **1** | `@basaltkit/drives` 0.1.0 — contract, credentials, connections, listing, streaming download, dedup, sync, retry, notification verification, fake provider, 231 tests, docs EN + PT | **done in this change** |
| **2** | HTTP routes (`driveRoutes()` over `@basaltkit/http`, all three adapters) + the **first** adapter, `@basaltkit/drives-dropbox` — chosen first because it is the only one with a real HMAC signature, so it validates the notification contract hardest | proposed |
| **3** | `@basaltkit/drives-google` and `@basaltkit/drives-microsoft`; `drives-prisma` and `drives-sqlite` stores | proposed |
| **4** | Consuming-app integration; admin UI for connections; `basalt drives:*` CLI if a second consumer justifies it | proposed |

Each adapter is expected to be small — the contract is designed so that an
adapter is translation, not logic. Every adapter must pass a shared conformance
suite (the fake provider is its executable specification).

---

## 10. Decisions for the maintainer

1. **Package name `@basaltkit/drives`** — approve, or pick from §2.3.
2. **`@basaltkit/drives` depends on `@basaltkit/webhooks`** for the SSRF guard.
   Accept as interim, or approve BK-028 first and depend on the promoted
   location instead.
3. **A second AES-256-GCM implementation exists** until BK-027 lands. Approve
   the debt, or approve the promotion now.
4. **Routes deferred to phase 2** (§6.4) — approve, or require them in phase 1
   on unverified handshake behaviour.
5. **Version `0.1.0`, unpublished**, matching how `subscriptions-appypay` was
   parked pending real-sandbox validation. The contract should not go to `1.0.0`
   until at least one real adapter has validated it against live traffic.

---

## Appendix — source anchors (verified)

| Claim | Anchor |
|---|---|
| `Disk` has putStream/getStream/copy/stat/temporaryUploadUrl | `packages/storage/src/index.ts:320` |
| Storage driver contract | `packages/storage/src/driver.ts:55` |
| `Files.upload` accepts a stream, sniffs, hashes, caps | `packages/files/src/files.ts:313` |
| `FileStore` takes an explicit `tenantId` first | `packages/files/src/store.ts:59` |
| `resolveFileTenant` anti-widening rules | `packages/files/src/files.ts:182` |
| OAuth callback discards the refresh token | `packages/auth/src/oauth.ts:309`, `exchangeCode` |
| `secret-box` is private to `auth` | `packages/auth/src/secret-box.ts`, imported only by `auth.ts:7` |
| SSRF guard exports | `packages/webhooks/src/ssrf.ts:158`, re-exported `packages/webhooks/src/index.ts` |
| `pinnedRequest` destroys the body | `packages/webhooks/src/pinned-fetch.ts` |
| Webhook tenancy anti-widening | `packages/webhooks/src/index.ts`, `WebhookManager.dispatch` |
| `defineJob` + context snapshot | `packages/queue/src/job.ts:77`, `packages/queue/src/manager.ts:219` |
| `defineReconciler` | `packages/scheduler/src/reconciler.ts:142` |
| HookBus + module augmentation | `packages/core/src/hooks.ts`, `packages/files/src/plugin.ts:9` |
| `'tenancy:active'` marker | `packages/tenancy/src/index.ts:558` |
| Coverage gate thresholds | `vitest.coverage.config.ts` |

*End of RFC 0002.*
