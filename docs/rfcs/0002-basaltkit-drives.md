# RFC 0002 — `@basaltkit/drives`: connecting a tenant's external file-storage accounts

- **Status:** Draft (phases 1 and 2a implemented — core abstraction, fake provider, HTTP routes and the first real adapter, `@basaltkit/drives-dropbox`; see Appendix B for what the first adapter changed)
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
| **2a** | HTTP routes (`driveRoutes()` over `@basaltkit/http`, parity-tested on all three adapters) + the **first** adapter, `@basaltkit/drives-dropbox` — chosen first because it is the only one with a real HMAC signature, so it validates the notification contract hardest | **done**; findings in Appendix B |
| **2b** | `@basaltkit/drives-google` and `@basaltkit/drives-microsoft` — see Appendix B.6 for what they inherit from 2a | proposed |
| **3** | `drives-prisma` and `drives-sqlite` stores | proposed |
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

---

## Appendix B — phase 2a findings (the first real adapter)

Phase 2a implemented `@basaltkit/drives-dropbox` and the HTTP routes §6.4
deferred. The contract held up, with **eight** changes — every one of them a
place where phase 1 had flattened a real vendor difference, and every one found
by writing the adapter rather than by reading the spec again.

### B.1 What changed, and why

| # | Phase 1 assumed | Dropbox does | Change |
|---|---|---|---|
| 1 | every vendor authenticates a notification with a secret **we** generated, so `verifyNotification` returns `secret` | no per-connection subscription at all: one webhook URI per *app*, signed with the app secret, naming the **accounts** that changed | `DriveNotificationResult.accountIds`; `handleNotification` correlates on `DriveConnection.account.id` when no secret is present |
| 2 | one notification resolves to one connection | one account can be connected many times (two labels, or two tenants) | `DriveNotificationOutcome.connections` is a list; phase 1 would have synced one and left the rest stale |
| 3 | a verified notification that matches nothing is an error (400) | — | it is now `reason: 'unmatched'` with a 200, because a different answer tells an unauthenticated caller which accounts a deployment holds |
| 4 | `startDelta` means "everything from now on" | `list_folder` **is** the head of the feed; there is no way to get a beginning-cursor without receiving the first page, and `get_latest_cursor` skips what exists | `DriveProvider.deltaIncludesExisting`, defaulting to `false` (the safe direction). The engine runs a listing pass before the first delta run when it is false — which is what Google Drive needs, and phase 1 would have imported **nothing** on a first sync there |
| 5 | a removal always names an id | a `deleted` entry is `{".tag":"deleted", name, path_lower, path_display}` and carries **no id** | `DriveChange`'s removal variant and `DriveRemoval` carry `externalId` *or* `path`. Smuggling a path into `externalId` would have made every ledger lookup miss in silence |
| 6 | a rate limit is a `Retry-After` header | frequently `429` with no header and `{"error":{"retry_after":300}}` in the body, which the guarded fetch destroys before an adapter sees it | `DriveProvider.retryAfterFromBody`, applied by the guard under a hard 8 KiB read bound |
| 7 | a change cursor, once obtained, stays valid | `list_folder` cursors age out and answer `409 reset/` — as Graph answers `410 resyncRequired` and Google invalidates a `pageToken` | `DriveCursorResetError`. The cursor is **persisted**, so mapped to any other error one expiry made every future sync of that connection fail identically for ever, with no retry policy able to help. `syncConnection` drops the cursor and reports `reset: true`; the next run re-primes |
| 8 | a request body is `string \| Buffer` | `files/upload` takes up to 150 MB | `GuardedRequestInit.body` accepts a `Readable`, piped and never buffered. Phase 1 made `DriveProvider.upload` unimplementable without a full in-memory copy per concurrent job |

Two additions and one bug fix came out of the same work:

- **`DRIVE_ACCESS_DENIED`, `DRIVE_ITEM_NOT_FOUND`, `DRIVE_PROVIDER_ERROR`.**
  Dropbox answers `403` for a team-policy refusal while the token is perfectly
  valid; folding that into `DRIVE_CREDENTIALS_INVALID` tells a tenant to
  re-consent forever over something re-consenting cannot fix. `DRIVE_PROVIDER_ERROR`
  is the one `DRIVE_` code whose retryability the *adapter* decides, so a
  provider 5xx is retried and a 4xx is not.
- **The reactive refresh in `Drives.run` did not exist.** §4.4 and the method's
  own doc comment described "a single reactive refresh if the provider rejects a
  token we believed was valid", and the code did not do it:
  `DRIVE_CREDENTIALS_INVALID` is terminal for `withRetry`, so a `401` from the
  provider failed the call outright. It now refreshes **once per `run`** (not
  per retry attempt, so a dead grant cannot drive one token-endpoint call per
  attempt) and retries the operation.

### B.2 The routes (§6.4 resolved)

`driveRoutes()` ships the connect flow and **one** notification endpoint over
`route()` from `@basaltkit/http`, parity-tested on Fastify, Express and Hono.
`DriveNotificationResult.challenge` did exactly what it was designed to do: one
route answers Dropbox's pre-subscription `GET ?challenge=`, Graph's
`POST ?validationToken=` and Google's `sync` message, and the Dropbox handshake
confirmed the important part — it arrives **before any connection exists**, so a
route that looked a connection up first could never have answered it.

The echo is `text/plain` with `X-Content-Type-Options: nosniff`, because it
reflects attacker-chosen text on the app's own origin.

### B.3 The one thing the neutral layer cannot do

**`@basaltkit/http` cannot give a route the raw request bytes.** Fastify,
Express and Hono all parse `application/json` before a handler runs, and the
neutral layer only leaves a body unread for `upload()` routes. Dropbox signs the
bytes that arrived, so a re-serialised body is a different message.

The route therefore **fails closed** (`DRIVE_NOTIFICATION_INVALID`) rather than
reconstructing one, and accepts the bytes from an explicit resolver,
`request.body` when it is already a `Buffer`/`string`, or `request.raw.rawBody`
— the convention a Fastify content-type parser and Express's `json({ verify })`
both use. The parity suite proves all three adapters work with one documented
line of wiring each, and proves the fail-closed path.

This is worth promoting, as **BK-029**: a `rawBody()` body marker in
`@basaltkit/http` mirroring `upload()`, with the same `isUploadBody`-style
probe in each adapter. It is not fully solvable in the neutral layer alone —
`express.json()` is installed app-wide by `expressPlugin` and would still need a
`type` filter or the `verify` hook — so the honest end state is a marker plus a
documented Express note, not a silent fix.

While reading for this, one adjacent latent bug surfaced and is **not** fixed
here because it belongs to another package: `billingWebhookRoute` in
`@basaltkit/subscriptions` falls back to `JSON.stringify(request.body)` when the
raw body is absent. Against a real Stripe endpoint that silently produces a
signature mismatch on every delivery.

### B.4 Multi-provider coexistence

Phase 1 was structurally multi-provider and **no test proved it** — every suite
registered a single adapter. With two real implementations in the tree that gap
is now closed by `packages/drives-dropbox/tests/multi-provider.test.ts`: one
tenant holding a fake connection and a Dropbox connection whose items share an
`externalId` *and* a path, asserting that calls route by connection rather than
by id, that the ledger stays distinct, that disconnecting one leaves the other
untouched, that a capability unsupported by one is unaffected for the other,
that a refresh touches exactly one row, and that a notification for one provider
can never select another's connection — including when a connection carries the
other vendor's account id. No contract change was needed: the model was right,
only unproven.

### B.5 Not verifiable without a real Dropbox app

Tested against a faithful fetch-level fake of the documented HTTP surface, with
no credentials. Open points, listed in the adapter's README: PKCE combined with
an app secret; whether a refresh ever returns a new `refresh_token`; the exact
`error_summary` strings for scope and team-policy refusals; whether a `429` ever
carries both a `Retry-After` and a body hint; and `content_hash` against a real
file (no official vector is published).

### B.6 What Google and Microsoft will need

- Declare `deltaIncludesExisting` **explicitly**. Google's
  `changes.getStartPageToken` is `false`; Graph's `/delta` is `true`.
- Both have per-subscription secrets, so both use
  `DriveNotificationResult.secret` and can keep `watch`/`unwatch`. Neither needs
  `accountIds`.
- Graph's `validationToken` handshake is already served by the shared route.
- Graph rotates refresh tokens; the engine's compare-and-set and
  rotation-race handling (§4.4) exists for exactly that and is unchanged.
- Graph's `@microsoft.graph.downloadUrl` and Google's redirect to
  `googleusercontent.com` are the SSRF cases §5.1 was written for; add the CDN
  hosts as `.suffix` entries, never bare parents.
- Both report deletions by id, so neither needs the `path` removal shape.

---

## Appendix C — phase 2b findings: `@basaltkit/drives-google`

The Google Drive half of phase 2b is implemented. Appendix B.6 predicted five
things about it; **all five held**, which is the more interesting result than any
one of them, because it means the contract's shape was derived correctly from
the vendor documentation rather than from the one vendor that had been built.

The contract needed **no change**. One engine *behaviour* changed — a skip
reason phase 1 declared and nothing ever emitted — and four places where the
contract deliberately flattens a difference turned out to cost something real
enough to write down.

### C.1 What B.6 predicted, and what happened

| B.6 said | Outcome |
|---|---|
| Declare `deltaIncludesExisting` explicitly; Google is `false` | **Confirmed.** `changes.getStartPageToken` is "from now on". A test declares `true` on purpose and asserts that the first sync reports success and imports nothing — which is what phase 1 would have shipped. |
| Per-subscription secret, so `watch`/`unwatch` and `DriveNotificationResult.secret`; no `accountIds` | **Confirmed.** `changes.watch` takes a `token` we choose, echoed as `X-Goog-Channel-Token`. `accountIds` is unused; `account.id` (the `permissionId`) is display data only. |
| The `googleusercontent.com` redirect is the SSRF case §5.1 was written for; add CDN hosts as `.suffix`, never bare parents | **Confirmed, and it is the load-bearing control.** `.googleusercontent.com` is allowlisted as a suffix; tests assert that both `googleusercontent.com` and `evilgoogleusercontent.com` are refused, and that no signed URL reaches an error. |
| Deletions by id, so no `path` removal shape | **Confirmed** — with a wrinkle the appendix could not have known (C.3). |
| Graph rotates refresh tokens; Google does not | **Confirmed.** Google returns a new access token only, and the engine's "keep the stored one when a provider omits it" rule is exactly right. |

### C.2 The one engine change

`importItem` now skips an item with `exportOnly: true` under the `copy`
strategy, with `reason: 'no-content'` — the skip reason phase 1 declared for
precisely this case and which nothing had ever emitted.

Without it, a Google Drive full of Docs and Sheets produces a permanently
failing import job per native document: `download` raises `DRIVE_UNSUPPORTED`,
which is terminal, the ledger never records a failure, and every subsequent sync
re-enqueues the same items for ever. Dropbox Paper docs have the same shape and
the same latent bug; this fixes both. `reference` is untouched, so an app that
wants to run `files.export` itself still receives the item in its sink.

### C.3 Where the contract flattens a real difference (Google column)

The four that cost something. None of them is worth a contract change; all four
are worth knowing about.

1. **`changes.list` is account-wide, and the contract has no vocabulary for
   that.** Dropbox's `list_folder` cursor is folder-scoped; Graph's `/delta` can
   be taken on a folder; Google has exactly one feed per account. A connection
   confined to a `rootId` therefore filters **client-side**, walking each changed
   file's `parents` upwards with one metadata read per unseen folder. That cost
   is invisible to the engine: `syncConnection` counts what the adapter reports,
   not what it discarded. The adapter caches ancestry for the duration of a
   single `delta` call and never longer — a shared cache keyed by file id would
   be a cross-connection leak waiting for a collision — and a hard lookup budget
   fails loudly rather than guessing, because guessing "in scope" leaks another
   folder's metadata and guessing "out of scope" loses a tenant's file.

   The isolation requirement is the sharp end of this: an out-of-scope change is
   dropped **before** it becomes a `DriveChange`, so it reaches neither
   `onRemoved`, nor the hooks, nor a ledger lookup. There is a test that asserts
   `result.seen === 0` for a change in a sibling folder.

2. **Drive has no recursive listing query, and `DriveListOptions.folderId` reads
   as if it did.** `'<id>' in parents` is one level. `syncConnection`'s backfill
   calls `list({ folderId: connection.rootId })`, so an adapter that answered
   literally would give a scoped connection a top-level-only first sync — and
   then the account-wide change feed would deliver the subfolders' files
   afterwards, as if they had appeared from nowhere. The adapter walks the
   subtree instead, carrying its folder queue inside the opaque cursor. The
   cursor being opaque by contract is what makes that legal; it is the same
   latitude Dropbox used for its synthetic start cursor, and it is the second
   time that one design decision has paid for itself.

3. **A hard deletion is unscopable.** Google reports deletions by id, as
   predicted — but `{fileId, removed: true}` carries no file resource at all, so
   a root-scoped connection cannot tell whether the deleted file was ever in its
   folder. Forwarding it would put an id from outside the connection's scope into
   the app's hooks; dropping it loses a real deletion. Neither is right, so the
   adapter drops it by default and offers `includeUnscopedRemovals` for apps that
   would rather correlate against their own ledger — which is the one component
   that genuinely knows which ids it imported. A trash (the ordinary Drive
   delete) carries the full resource and is scoped normally, so the common case
   is unaffected.

4. **`invalid_grant` means three different things.** Revoked consent, a deleted
   OAuth client, and a grant that simply went unused for six months (seven days
   while the app is in "testing") are the same string on the wire. The contract
   has one terminal status, `invalid`, and cannot distinguish them. That is
   acceptable — the available action is identical in all three cases — but an
   operator reading "needs to be reconnected" cannot tell a revocation from an
   expiry, and no adapter can tell them.

Two flattenings that are **right** and should stay: the single opaque cursor
(Google's `nextPageToken` / `newStartPageToken` pair collapses into it honestly,
with `hasMore` carrying the distinction), and `contentType` as an untrusted hint
(Drive's `mimeType` is authoritative for native documents and a client-supplied
guess for everything else, so "hint" is correct for both).

### C.4 The rate-limit shape, and why it nearly went wrong

Google throttles with **`403`**, not `429`:

```json
{"error":{"code":403,"errors":[{"domain":"usageLimits",
  "reason":"userRateLimitExceeded","message":"User Rate Limit Exceeded"}]}}
```

The guarded fetch's `429`/`503` interception therefore never fires for the common
case, and the obvious implementation — map `403` to `DRIVE_ACCESS_DENIED`, as the
Dropbox adapter correctly does — makes every throttle **terminal**, because
`isRetryable` treats `DRIVE_ACCESS_DENIED` as a decision rather than a fault. A
tenant whose sync merely went too fast would get a permanently failed job and a
message about a permission problem they do not have.

So the adapter reads `error.errors[].reason` and splits `403` three ways:
`usageLimits` throttles become `DRIVE_RATE_LIMITED` (retryable), genuine
permission refusals become `DRIVE_ACCESS_DENIED` (terminal), and anything
unrecognised becomes `DRIVE_PROVIDER_ERROR` — never a permission claim, because
telling a tenant to fix a permission they cannot see is worse than saying the
provider failed.

`retryAfterFromBody` is **not** declared: Google uses `Retry-After` when it
sends a hint at all, which is the interoperable path the engine already takes.
The member exists for Dropbox and stays Dropbox-shaped.

### C.5 Contract-validation matrix — Google column

Same rows as B's matrix. "Fits" means it maps with no caveat worth writing down.

| Capability | Google | Note |
|---|---|---|
| OAuth | fits | `access_type=offline` + `prompt=consent` + PKCE S256, all inside the pure `authorizeUrl`. `prompt=consent` is not optional: without it a user who already consented gets no refresh token on any later connect. |
| Refresh token | fits | No rotation. "Keep the stored one when the response omits it" is exactly right. |
| Revocation | caveat | Revoking the **refresh** token revokes the grant. But `invalid_grant` conflates revocation with disuse expiry (C.3.4). |
| List files | caveat | No recursive query; a scoped listing walks the subtree inside the opaque cursor (C.3.2). |
| List folders | fits | Folders are files with a folder mime type; the engine skips them for import and the walk follows them. |
| Pagination | fits | `pageToken` is an opaque resumable cursor — the contract's shape exactly. |
| Download | caveat | Streams, but via `302` to a signed `*.googleusercontent.com` URL that the guarded fetch re-validates. Google-native documents cannot be downloaded at all. |
| File metadata | caveat | No `path` (Drive is a graph; a file may have several parents). `version` is `headRevisionId`, not Drive's `version` counter, which moves on a rename and would force a re-download. |
| Change detection | caveat ×2 | `deltaIncludesExisting: false`, and the feed is account-wide (C.3.1). |
| Webhooks | fits | Per-subscription channel with our token; `expiresAt` carries Google's own expiration; `raw` carries the `resourceId` that `channels.stop` needs. Renewal is the app's, via `defineReconciler`. |
| Webhook verification | fits, weakly | The `secret` correlation is right, but Google signs nothing — the channel token is the entire authentication. A vendor property, not a contract gap. |
| Rate limits | caveat | A throttle is a `403` (C.4). |
| Retry | fits | `isRetryable` already covers `DRIVE_RATE_LIMITED` and a retryable `DRIVE_PROVIDER_ERROR`. |
| Large files | caveat | Download unbounded (the engine's cap applies); **upload capped at 5 MB** because `uploadType=resumable` is not implemented, refused up front with `DRIVE_CONTENT_TOO_LARGE`. |
| Errors | fits | `DRIVE_ACCESS_DENIED` / `DRIVE_ITEM_NOT_FOUND` / `DRIVE_PROVIDER_ERROR` / `DRIVE_CURSOR_RESET` cover Google's taxonomy with nothing left over. |

### C.6 Multi-provider coexistence, again

`packages/drives-google/tests/multi-provider.test.ts` repeats B.4's suite with
Google in place of Dropbox, and adds the collision Google makes possible: both
the fake and Google authenticate a notification with **a secret the engine
generated**, so the test gives the fake connection the Google connection's
channel secret verbatim and asserts that the provider filter — not luck — is
what keeps them apart. The ids and paths collide too. No contract change was
needed; the model was right, and is now proven for a third adapter.

### C.7 Not verifiable without a real Google project

Tested against a faithful fetch-level fake of the documented HTTP surface, with
no credentials. Open points, listed in the adapter's README: the exact maximum
channel TTL for `changes.watch` and whether Google clamps or refuses a larger
one; whether an aged-out `pageToken` really answers `400 invalid` (Google
publishes no distinct code, and `404 notFound` is mapped too); whether the
download redirect ever leaves `*.googleusercontent.com` (if it does, downloads
fail **closed** and visibly); whether a refresh ever returns a new
`refresh_token`; PKCE together with a client secret on a Web-application client;
and the `403` reason strings for Workspace DLP and sharing-policy refusals.

---

## Appendix D — phase 2c findings: `@basaltkit/drives-microsoft`

The OneDrive / SharePoint half is implemented. Appendix B.6 predicted six things
about Microsoft; **all six held**. The contract needed **three changes** — two
additive fields and one behaviour fix in the guarded fetch — and every one of
them is a place where the contract, or the guard, was right for the two vendors
already built and wrong for the third.

### D.1 What B.6 predicted, and what happened

| B.6 said | Outcome |
|---|---|
| Declare `deltaIncludesExisting` explicitly; Graph is `true` | **Confirmed.** `/delta` with no token enumerates the drive and only then hands over a `deltaLink`. The first sync runs in `delta` mode and a test asserts no `/children` call happens at all. |
| Per-subscription secret, so `watch`/`unwatch` and `DriveNotificationResult.secret`; no `accountIds` | **Confirmed — with one wrinkle (D.2.1).** `clientState` is the whole authentication; `accountIds` is unused. |
| The `validationToken` handshake is already served by the shared route | **Confirmed**, and it arrives *inside* `POST /subscriptions` rather than at registration time, so `watch()` itself fails if the route is unreachable. One caveat for the routes owner, D.5. |
| Graph rotates refresh tokens; the §4.4 compare-and-set exists for exactly that | **Confirmed, and it is load-bearing.** A test drives the race: a stale worker's `invalid_grant` is byte-identical to a revoked grant, and without the re-read the engine would mark a healthy connection `invalid` at random under load. |
| `@microsoft.graph.downloadUrl` is the SSRF case §5.1 was written for; add CDN hosts as `.suffix`, never bare parents | **Confirmed, and it exposed a guard bug (D.2.3).** `.files.1drv.com`, `.sharepoint.com` and `.svc.ms`; tests assert `sharepoint.com` and `evilsharepoint.com` are both refused. |
| Deletions by id, so no `path` removal shape | **Confirmed.** `{ id, deleted: { state } }`, and `DriveRemoval.targetId` resolves. |

### D.2 What the contract had to change

**1. `DriveNotificationResult.secrets` — a delivery can name several
subscriptions.** Graph posts `{"value":[…]}`, and every subscription that shares
a notification URL can contribute an entry. Two connections in one tenant behind
one route is the ordinary case, not an exotic one. With a single `secret` the
adapter could only report the first, and the engine would sync one connection
and leave the rest stale — the same failure `accountIds` and
`DriveNotificationOutcome.connections` were introduced for in phase 2a, arriving
from the other direction. `matches()` now accepts either shape; an adapter sets
`secret` for the ordinary delivery and `secrets` for a batch.

**2. `DriveRefreshInput.scopes` — the engine knew, and was not telling.**
Microsoft wants a refresh request's `scope` to be a subset of the original
grant's. `DriveRefreshInput` carried only the refresh token, so an adapter could
only send its own defaults: a connection that consented to `Sites.Read.All`
would be refreshed down to `Files.Read` and keep working until the first
SharePoint call, which then fails as a permissions problem a long way from the
cause. The connection already stores its granted scopes, so `credentials.ts`
passes them. Dropbox and Google ignore the field.

There is a matching asymmetry that is **not** fixed, deliberately:
`DriveExchangeInput` has no `scopes`, so an adapter cannot know what
`startAuthorization({ scopes })` asked for. For Microsoft that turned out to be
the right shape — the authorization code already names the consent, Entra ID
reports the granted scopes back in the token response, and this adapter
therefore sends **no** `scope` on the code exchange. An adapter that needed it
would have a real gap; none of the three does.

**3. The guarded fetch forwarded credentials across a cross-host redirect.**
Not an API change — a bug the first two adapters could not reach.
`createDriveFetch` re-validated every hop (allowlist, SSRF, pinning) but reused
`init.headers` unchanged, so an `Authorization` header followed a `302` to
another host. Graph's `/content` redirects to a SharePoint or `1drv.com` CDN,
and Google Drive's download redirects to `googleusercontent.com`: in both cases
the framework would have presented a provider-wide bearer token to a host that
already holds a narrow pre-signed URL and needs nothing. The hop is now stripped
of `authorization`, `cookie` and `proxy-authorization` when the host changes.
The allowlist bounds *which* hosts a redirect may reach; it never made them
entitled to the token.

An adapter-side consequence worth stating: this adapter's primary download path
does not rely on the fix. It reads `@microsoft.graph.downloadUrl` and fetches it
**unauthenticated**, so the token is never on that wire at all; `/content` is
only a fallback. The guard fix is what makes the fallback safe — and what makes
it safe for anyone else who authenticates a request that then redirects.

### D.3 Where the contract flattens a real difference (Microsoft column)

Four that cost something. None is worth a further contract change.

1. **`revoke` does not exist, and `revoked: false` is the only way to say so.**
   Graph has no per-application revocation endpoint at all —
   `POST /me/revokeSignInSessions` invalidates the user's tokens for *every*
   application, which is not what "disconnect this drive" means. The contract
   makes `revoke?` optional, which is exactly the right latitude, and
   `disconnect` reports `revoked: false`. But that one boolean carries two very
   different meanings: on Dropbox it means "we tried and the provider was down",
   and here it means "there is nothing to try, and the grant may still be live
   until the user removes it in their account portal". An operator reading a
   `drive:disconnected` event cannot tell those apart. Documented loudly in the
   adapter README and the guide rather than encoded, because a third status
   would be a contract change carrying one vendor's absence into every adapter.

2. **`rootId` is one opaque string, and Graph needs a *pair*.** A connection can
   mean a personal OneDrive, a specific drive by id, or a SharePoint site's
   default document library, and a Graph drive id and site id are both opaque
   strings that cannot be told apart by inspection. The adapter defines a small
   grammar inside `rootId` (`drive:{id}`, `site:{id}`, `.../item:{id}`) and
   exports `microsoftRoot()` to build one. The opacity of `rootId` is what makes
   this legal — the same latitude Dropbox used for its synthetic start cursor and
   Google used for its folder-queue cursor, now paying for itself a third time.
   The sharp edge is that `rootId` is **caller-controlled**: `driveRoutes()`
   takes it from `?rootId=` and it becomes part of a Graph request path, so every
   segment is validated (`.`, `..`, `/`, `?`, `#`, `%`, `:` and whitespace all
   refused) and the refusal never echoes the handle back.

3. **A checksum is comparable within one provider — and here, only within one
   account type.** `DriveChecksum` carries the algorithm name, which is what
   makes this survivable, but Graph publishes `quickXorHash` on Business and
   SharePoint and `sha1Hash`/`sha256Hash` on personal OneDrive. So "the same
   provider" is not a fine enough grain for Microsoft: two connections of the
   same adapter can report incomparable digests for identical bytes. The adapter
   labels what it actually got and the README says so; nothing in the contract
   needs to change, but an app that dedups on `checksum` across connections will
   be wrong on Microsoft in a way it is not wrong on Dropbox.

4. **A subscription is drive-scoped while a connection can be folder-scoped.**
   Graph only accepts a drive root as a `driveItem` subscription resource, so a
   connection confined to a subfolder is still *notified* about the whole drive.
   The contract has no vocabulary for "the watch is wider than the connection",
   and it costs a wasted sync rather than a wrong one — the sync itself stays
   confined — so it is documented rather than modelled.

One flattening that is **right** and should stay: the single opaque cursor.
Graph's `@odata.nextLink`/`@odata.deltaLink` pair is a full URL rather than a
token, which looks like a problem for an opaque `string` and is not: the adapter
wraps the URL, `hasMore` carries the next/final distinction honestly, and
wrapping is what keeps a provider URL out of an app's database as something
fetchable. Unwrapping re-checks that it still points at Graph before the guard
re-validates it for real — a provider-supplied URL the framework then fetches is
precisely what §5.1 is about.

### D.4 Contract-validation matrix — Microsoft column

Same rows as B's and C's. "Fits" means it maps with no caveat worth writing down.

| Capability | Microsoft | Note |
|---|---|---|
| OAuth | fits | `login.microsoftonline.com/{tenant}/oauth2/v2.0`, PKCE S256, `offline_access`, `response_mode=query`, all inside the pure `authorizeUrl`. `common` / `organizations` / `consumers` / a tenant GUID are one option; the tenant is validated at construction because it lands in the authority path. |
| Refresh token | **caveat — and the contract changed** | Rotates on **every** refresh; the old token dies immediately. The engine's compare-and-set and lost-race re-read (§4.4) handle it, tested. `DriveRefreshInput.scopes` had to be added (D.2.2), because Microsoft wants the refresh scope to be a subset of the grant. |
| Revocation | **does not fit — and the contract already said it might** | No per-application revoke exists. `revoke?` is optional, so it is omitted and `disconnect` reports `revoked: false`; the grant may stay live until the user removes consent in their portal (D.3.1). |
| List files | caveat | `/children` is one level, which is what the contract means, and `folderId` narrows within the connection's drive only — a handle naming another drive is refused, not ignored. `rootId` carries a drive/site selector (D.3.2). |
| List folders | fits | A `folder` facet; the engine skips them for import and a listing walks them by id. |
| Pagination | caveat | `@odata.nextLink` is a **complete URL**, not a token. Wrapped in an opaque cursor, host-checked on the way out, then SSRF-validated by the guard. |
| Download | caveat ×2 | `@microsoft.graph.downloadUrl` is a pre-signed URL on a CDN host **and is itself a bearer credential** — never selected into a listing, never in `raw`, never in an error, fetched with no `Authorization`. `/content` is a `302` fallback, and following it safely required the guard fix (D.2.3). |
| File metadata | caveat | `version` is `cTag`, not `eTag` (which moves on a rename and would force a re-download). `path` is reconstructed from `parentReference.path` by stripping Graph's `…root:` addressing prefix. `checksum` differs by account type (D.3.3). |
| Change detection | fits | `deltaIncludesExisting: true`, so the feed *is* the backfill. `/delta` works on a drive root or a folder. `410 resyncRequired` → `DRIVE_CURSOR_RESET`, which drops the persisted cursor and re-primes. |
| Webhooks | caveat | Per-subscription `clientState` we generate; `expiresAt` surfaced and renewal is the app's, via `defineReconciler`. Two caveats: Graph validates the notification URL **synchronously inside** `POST /subscriptions`, so an unreachable route fails `watch()` itself; and a subscription is drive-scoped even when the connection is not (D.3.4). |
| Webhook verification | **caveat — and the contract changed** | No signature anywhere: `clientState` is the entire authentication, so an entry without one is rejected. One delivery can batch several subscriptions, which needed `DriveNotificationResult.secrets` (D.2.1). |
| Rate limits | fits | `429`/`503` with `Retry-After`, always — the interoperable path the guard already takes. No `retryAfterFromBody`: a parser that could only return `undefined` would make the guard read a body it is right to destroy. (Contrast Google, C.4, where a throttle is a `403`.) |
| Retry | fits | `isRetryable` covers it, plus one 4xx worth retrying: `423 Locked` (checked out, virus-scanned, co-authored) maps to a retryable `DRIVE_PROVIDER_ERROR`, which is the member's whole purpose. |
| Large files | caveat | Download unbounded (the engine's cap applies); **upload capped at 4 MB** — the lowest of the three — because `createUploadSession` is not implemented. Refused up front with `DRIVE_CONTENT_TOO_LARGE`. |
| Errors | fits | Real HTTP status codes, unlike Dropbox's universal `409` and Google's `403` throttle. `DRIVE_CREDENTIALS_INVALID` / `DRIVE_ACCESS_DENIED` / `DRIVE_ITEM_NOT_FOUND` / `DRIVE_CURSOR_RESET` / `DRIVE_PROVIDER_ERROR` cover Graph's taxonomy with nothing left over. Only `error.code` is forwarded — `error.message` quotes the request, and on a download path the request is a credential. |

### D.5 One thing for the routes owner

The shared POST notification route reads the raw body **before** it looks at the
query string. Graph's validation handshake is a POST with `?validationToken=…`
and an **empty** body, so it only survives `rawBodyOf` where the app's raw-body
wiring yields an empty `Buffer`/string rather than nothing at all — and a
Fastify or Express app with no parser registered for Graph's `text/plain`
content type may yield nothing. The fail-closed behaviour is right in general
and wrong for this one shape: a handshake that cannot be answered means
`watch()` fails, with a `subscriptionValidationFailed` that points at the wrong
thing. Checking the query for a challenge before demanding bytes would fix it;
it is in `packages/drives/src/routes.ts`, which phase 2c did not touch.

### D.6 Multi-provider coexistence, again

`packages/drives-microsoft/tests/multi-provider.test.ts` repeats B.4's and C.6's
suite a third time, and adds the two collisions Microsoft makes possible: the
fake connection is given the Graph connection's **channel secret** verbatim (the
provider filter, not luck, is what keeps them apart), and the rotation test
asserts that rotating Microsoft's refresh token leaves the fake's sealed blob and
revision untouched — a rotation that bled across providers would leave the other
connection holding a token its own provider never issued. It also asserts the
capability asymmetry in both directions: the fake refuses uploads and revokes its
grant, Microsoft accepts small uploads and has no revocation to perform.

### D.7 Not verifiable without a real Entra ID app registration

Tested against a faithful fetch-level fake of Graph's documented HTTP surface,
with no credentials and no network. Open points, listed in the adapter's README:
whether every account type really rotates the refresh token (the fake always
does, which is the harder direction); the exact `error.code` strings for a
missing `Sites.Read.All`, a sensitivity label and a conditional-access refusal;
whether a `429` ever arrives without `Retry-After` (if it does, this adapter
should declare `retryAfterFromBody` after all); whether `$select` really
suppresses `@microsoft.graph.downloadUrl` on every tenant, which is what keeps
the credential out of listings; `/delta` on a large SharePoint library and
whether a `deltaLink` outlives the sync interval; the exact
`expirationDateTime` ceiling per resource type; and whether a batched delivery
really mixes `clientState` values in the wild — the handling exists because the
envelope allows it.
