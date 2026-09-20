import type { Readable } from 'node:stream'
import type { GuardedFetch } from './fetch.js'

/**
 * The provider-neutral contract. Everything above it — connections, credential
 * storage, refresh, pagination, dedup, sync, import — is written once in this
 * package; an adapter (`@basaltkit/drives-google`, `-microsoft`, `-dropbox`)
 * only translates one vendor's API into these shapes.
 *
 * Two rules keep adapters small and safe, and both are enforced rather than
 * documented:
 *
 * - **An adapter never sees the refresh token, the client secret or the store.**
 *   It is handed a {@link DriveSession} with one short-lived access token. A bug
 *   (or a malicious dependency) inside an adapter therefore cannot exfiltrate
 *   the long-lived credential or reach another tenant's rows.
 * - **An adapter never calls `fetch` itself.** It calls `session.fetch`, which
 *   is host-allowlisted, SSRF-validated, IP-pinned, byte-capped and timed out.
 */

/**
 * A digest the provider publishes for an item's content.
 *
 * **Comparable within one provider — and not always even that.** The algorithm
 * name is part of the value for a reason: an adapter reports what the vendor
 * actually published, and the vendors publish different functions of different
 * inputs.
 *
 * - **Dropbox** — `dropboxContentHash`, a block-tree construction. It is *not*
 *   the SHA-256 of the file, despite being built out of SHA-256.
 * - **Google Drive** — `md5`, a real MD5, and **only for binary files**. A
 *   native Doc, Sheet or Slide publishes no checksum and no `size` at all; it
 *   carries {@link DriveItem.exportOnly} instead, and `contentVersion` falls
 *   back to `updatedAt` for it.
 * - **Microsoft Graph** — `quickXorHash` (base64) on OneDrive for Business and
 *   SharePoint, `sha1`/`sha256` on personal OneDrive. "The same provider" is
 *   therefore not a fine enough grain here: **two connections of the same
 *   adapter can report incomparable digests for identical bytes.**
 *
 * The rule an app needs: compare `algorithm` before `value`, and do not dedup
 * on a checksum across connections without checking both. {@link contentVersion}
 * already does — it uses the checksum only behind the provider's own revision,
 * and prefixes the algorithm onto the version string so two algorithms can
 * never collide into "unchanged".
 *
 * An app that wants one digest it can compare everywhere should hash the bytes
 * it imported rather than the ones the vendor described: `@basaltkit/files`
 * computes a SHA-256 as they stream past.
 */
export interface DriveChecksum {
  /** Lowercase algorithm name as the provider calls it: `md5`, `sha1`, `sha256`, `quickXorHash`, `dropboxContentHash`. */
  algorithm: string
  /** Lowercase hex, or the provider's own encoding when it is not a plain digest. */
  value: string
}

/** One file or folder at the provider. */
export interface DriveItem {
  /** Provider-assigned id, stable for the item's lifetime. Unique within a connection. */
  externalId: string
  name: string
  kind: 'file' | 'folder'
  /**
   * Media type as the provider reports it.
   *
   * **Never trusted.** It is a hint for filtering and display only; the real
   * type is decided by sniffing the bytes on the way in (`@basaltkit/files`
   * `validate.sniff`). Providers echo whatever the uploading client declared.
   */
  contentType?: string
  /** Size in bytes when the provider reports one. A hint: the import enforces its own cap. */
  size?: number
  /** Parent folder's `externalId`; absent at the connection root. */
  parentId?: string
  /** Display path when the provider exposes one (`/Finance/2026/invoice.pdf`). */
  path?: string
  /**
   * Opaque content-version marker — a revision id, an etag, a generation
   * number. Together with {@link checksum} this is what tells an incremental
   * sync that an item it already imported has actually changed.
   */
  version?: string
  /**
   * Read {@link DriveChecksum} before comparing one against anything: it is
   * comparable within a provider, and on Microsoft only within one account
   * type, and a Google-native document has none at all.
   */
  checksum?: DriveChecksum
  /** Epoch ms. */
  createdAt?: number
  /** Epoch ms. */
  updatedAt?: number
  /**
   * A link a human can open at the provider. Stored and shown; **never fetched
   * by the framework** — it is a provider-controlled URL, so treating it as a
   * request target would be an SSRF sink.
   */
  externalUrl?: string
  /**
   * The item has no directly downloadable bytes — a Google Docs/Sheets file has
   * to be exported to a concrete format first. The adapter decides what
   * `download` produces for it (and may refuse); the engine only needs to know
   * that `size`/`checksum` will usually be absent.
   */
  exportOnly?: boolean
  /** Anything vendor-specific the app may want. Must be JSON-serialisable. */
  raw?: Record<string, unknown>
}

/**
 * One page of results. `cursor` is opaque to everything above the adapter; when
 * it is absent the listing is complete.
 *
 * Deliberately *not* offset/limit: not one of the three target providers offers
 * stable offsets, and an offset over a mutating folder silently skips items.
 */
export interface DrivePage<T> {
  items: T[]
  cursor?: string | undefined
}

/** What changed since a delta cursor. */
export type DriveChange =
  | { type: 'upserted'; item: DriveItem }
  /**
   * An item the provider says is gone.
   *
   * Both fields are optional because the vendors genuinely disagree about what
   * a deletion *is*, and phase 1 was hiding that behind a required id:
   *
   * - **Google Drive** and **Microsoft Graph** report a deletion against the
   *   item's id, which is what the import ledger is keyed by.
   * - **Dropbox** does not. A deleted entry in `files/list_folder` is
   *   `{".tag":"deleted", name, path_lower, path_display}` — it carries **no
   *   id at all**, because the id belonged to the thing that no longer exists.
   *   The only handle is the path.
   *
   * Putting a path in `externalId` would have kept the type tidy and made every
   * ledger lookup silently miss. An adapter sets whichever it actually has (at
   * least one), and the engine reports both to `onRemoved` so an app can
   * correlate on the path it stored at import time (`filesSink` records it as
   * `metadata.drivePath`).
   */
  | { type: 'removed'; externalId?: string | undefined; path?: string | undefined }

/**
 * One page of a delta/change feed.
 *
 * `cursor` is always the cursor to resume from **after** applying `changes`, so
 * a crash between pages loses at most one page of progress and never skips one.
 */
export interface DriveDelta {
  changes: DriveChange[]
  cursor: string
  /** More pages are available right now; call again immediately rather than waiting for the next scheduled run. */
  hasMore: boolean
}

/** Bytes coming out of a provider. The caller must consume or destroy `stream`. */
export interface DriveContent {
  stream: Readable
  /** What the transport said, if anything. Still only a hint — the bytes are sniffed. */
  contentType?: string | undefined
  /** Exact length when the transport declared one. */
  size?: number | undefined
}

/** OAuth tokens as an adapter reports them. */
export interface DriveTokens {
  accessToken: string
  /**
   * Absolute expiry in epoch ms. Absent means "unknown": the engine will then
   * only refresh reactively, after a 401.
   */
  expiresAt?: number | undefined
  /**
   * Present on the first grant, and again on every refresh for providers that
   * **rotate** refresh tokens (Microsoft identity platform does; Dropbox and
   * Google normally do not). When present it replaces the stored one — dropping
   * it breaks the connection at the next refresh.
   */
  refreshToken?: string | undefined
  scopes?: readonly string[] | undefined
}

/** What the engine hands an adapter for one call. Scoped, short-lived, minimal. */
export interface DriveSession {
  /** Short-lived access token, already refreshed if it was close to expiry. */
  readonly accessToken: string
  /** The connection this call belongs to — for adapter-side logging and per-connection state. */
  readonly connectionId: string
  readonly tenantId: string
  /** Folder the connection is confined to, when one was chosen at connect time. */
  readonly rootId?: string | undefined
  /** The ONLY way an adapter may talk to the network. */
  readonly fetch: GuardedFetch
  /** Cancels in-flight work when the caller aborts (request closed, job cancelled). */
  readonly signal?: AbortSignal | undefined
}

export interface DriveListOptions {
  /** Folder to list. Defaults to the connection root. */
  folderId?: string | undefined
  /** Resume token from a previous {@link DrivePage}. */
  cursor?: string | undefined
  /** Page-size hint. An adapter may clamp it to what its API allows. */
  limit?: number | undefined
}

/** What an adapter needs to build a consent URL. */
export interface DriveAuthorizeInput {
  redirectUri: string
  /** Opaque CSRF value the engine generated; echo it into the provider's `state`. */
  state: string
  /** Base64url S256 challenge. Providers that do not support PKCE may ignore it. */
  codeChallenge: string
  /** Overrides the adapter's default scopes. */
  scopes?: readonly string[] | undefined
}

export interface DriveExchangeInput {
  code: string
  redirectUri: string
  codeVerifier: string
  fetch: GuardedFetch
}

export interface DriveRefreshInput {
  refreshToken: string
  fetch: GuardedFetch
  /**
   * The scopes the connection was actually granted, as stored on it.
   *
   * Present because the Microsoft identity platform wants a refresh request's
   * `scope` to be a subset of the original grant's, and an adapter that has to
   * guess can only guess its own defaults. A connection that consented to
   * `Sites.Read.All` would then be refreshed down to `Files.Read`: it keeps
   * working until the next call that needs the wider scope, which fails as a
   * permissions problem a long way from the cause. Dropbox and Google ignore
   * it.
   */
  scopes?: readonly string[] | undefined
}

/** Who the tokens belong to at the provider — shown in the UI, and used to spot duplicate connections. */
export interface DriveAccount {
  id?: string | undefined
  email?: string | undefined
  name?: string | undefined
}

/** The OAuth half of an adapter. Kept separate because it is the only part that touches long-lived secrets. */
export interface DriveAuthorization {
  /** Builds the provider's consent URL. Pure — no I/O. */
  authorizeUrl(input: DriveAuthorizeInput): string
  /** Exchanges an authorization code for the first token pair. */
  exchange(input: DriveExchangeInput): Promise<DriveTokens>
  /**
   * Refreshes an expired access token.
   *
   * Throw {@link DriveCredentialsInvalidError} when the provider says the grant
   * is gone (`invalid_grant`, a revoked consent): that is terminal, and the
   * engine marks the connection `invalid` instead of retrying forever. Any
   * other error is treated as transient and retried with backoff.
   */
  refresh(input: DriveRefreshInput): Promise<DriveTokens>
  /** Best-effort revocation at the provider when a connection is disconnected. */
  revoke?(input: { tokens: DriveTokens; fetch: GuardedFetch }): Promise<void>
  /** Identity behind the tokens, for display and duplicate detection. */
  account?(session: DriveSession): Promise<DriveAccount>
}

/** A push subscription registered at the provider. */
export interface DriveWatch {
  /** The provider's own subscription/channel id — needed to unsubscribe. */
  id: string
  /** When the provider will stop sending; the app renews before this. All three vendors expire subscriptions. */
  expiresAt?: number | undefined
  /** Vendor state the adapter needs on renewal or teardown. Persisted with the connection. */
  raw?: Record<string, unknown> | undefined
}

export interface DriveWatchInput {
  /** Public HTTPS URL the provider will call. */
  notificationUrl: string
  /**
   * Shared secret the engine generated for this subscription. The adapter must
   * pass it to the provider in whatever slot the vendor offers (Graph
   * `clientState`, Google channel `token`) so an inbound notification can be
   * tied back to one connection.
   */
  secret: string
  /** Renewal hint; an adapter clamps it to the vendor's maximum. */
  ttlMs?: number | undefined
}

/** A raw inbound notification, handed to the adapter for verification. */
export interface DriveNotificationInput {
  method: string
  /** Lowercased header names. */
  headers: Record<string, string | undefined>
  /** Query parameters of the callback URL. */
  query: Record<string, string | undefined>
  /**
   * The **raw** request body, exactly as received.
   *
   * A `Buffer`, not a parsed object: HMAC schemes (Dropbox signs the raw body)
   * break the moment the bytes are re-serialised, and a route that parses first
   * cannot verify afterwards.
   */
  body: Buffer
}

/**
 * The outcome of verifying an inbound notification.
 *
 * `challenge` covers the handshake every one of the three vendors performs
 * before it will deliver anything: Microsoft Graph POSTs a `validationToken`
 * that must be echoed as `text/plain`, Dropbox GETs a `challenge` parameter,
 * Google sends a `sync` state message. Returning it lets one neutral route
 * answer all three.
 */
export interface DriveNotificationResult {
  /** Respond 200 with exactly this body (and `content-type: text/plain`), and do nothing else. */
  challenge?: string | undefined
  /**
   * Secret the provider echoed back, for the engine to match against a
   * connection — present only for vendors that let us choose one (Graph
   * `clientState`, Google channel `token`).
   *
   * **Dropbox has none.** Its webhook URI is registered once per *app* in the
   * App Console, not per connection: there is no subscription to attach a
   * secret to, the payload is signed with the app secret instead, and the
   * connection is identified by {@link accountIds}. Phase 1 assumed every
   * vendor authenticates with a secret we generated; the first real adapter
   * proved otherwise, so a result may now carry `accountIds` instead.
   */
  secret?: string | undefined
  /**
   * Several secrets, when **one delivery batches notifications for more than
   * one subscription**.
   *
   * Microsoft Graph posts a `{"value":[…]}` envelope, and every subscription
   * that shares a notification URL can contribute an entry to it — two
   * connections of one tenant, or two tenants behind one route. Reporting only
   * the first `clientState` would sync one connection and leave the rest
   * stale, which is the same failure {@link accountIds} and
   * `DriveNotificationOutcome.connections` were introduced for in phase 2a,
   * arriving from the other direction.
   *
   * An adapter sets {@link secret} for the ordinary one-subscription delivery
   * and this for a batch; the engine matches a connection against either.
   */
  secrets?: readonly string[] | undefined
  /** Provider subscription/channel id, when the notification carries one. */
  watchId?: string | undefined
  /** Whether this notification means "there is new work" (most are content-free pings). */
  changed: boolean
  /** Vendor id the notification is about, when it names one. Most vendors do not. */
  externalIds?: readonly string[] | undefined
  /**
   * Provider **account** ids the notification is about — Dropbox's
   * `list_folder.accounts` (`dbid:…`).
   *
   * Matched against {@link DriveConnectionAccount.id}. One notification can name
   * several accounts, and one account can be connected more than once (two
   * labels, or two tenants), so this resolves to a **set** of connections rather
   * than one.
   *
   * It is only ever consulted once the adapter has *authenticated* the
   * notification — for Dropbox, an HMAC-SHA256 over the raw body under the app
   * secret. An account id a caller merely asserts must never select a
   * connection.
   */
  accountIds?: readonly string[] | undefined
}

/**
 * A file-storage provider adapter.
 *
 * Only `name`, `allowedHosts`, `authorization`, `list` and `download` are
 * required. Everything optional degrades honestly: the engine reports
 * {@link DriveUnsupportedError} rather than silently doing nothing, and falls
 * back to a full listing when `delta` is absent.
 */
export interface DriveProvider {
  /** Stable identifier, stored on every connection: `google`, `microsoft`, `dropbox`. */
  readonly name: string
  /**
   * Every host this adapter is allowed to open a connection to.
   *
   * The allowlist is the load-bearing SSRF control. Provider *responses* carry
   * URLs the framework then fetches (Graph's `@microsoft.graph.downloadUrl`,
   * Google's redirect to `googleusercontent.com`), and those are attacker-
   * influenced data. An entry is either an exact host (`api.dropboxapi.com`) or
   * a leading-dot suffix (`.googleusercontent.com`) that matches subdomains
   * only — never the bare parent.
   */
  readonly allowedHosts: readonly string[]
  readonly authorization: DriveAuthorization
  /** Lists one page of a folder. */
  list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>>
  /** Fetches one item's metadata. `null` when it no longer exists. */
  get?(session: DriveSession, externalId: string): Promise<DriveItem | null>
  /** Opens the item's bytes. Must not buffer them. */
  download(session: DriveSession, item: DriveItem): Promise<DriveContent>
  /**
   * Writes a file back to the provider. Optional — most apps only read.
   *
   * **Every adapter has a hard size ceiling, and it is low.** A single-request
   * upload is all any of them implements, because the alternative on all three
   * vendors is a multi-call resumable session with its own chunking, its own
   * 308-based resumption and its own failure modes:
   *
   * | Adapter | Ceiling | What a larger file would need |
   * |---|---|---|
   * | `@basaltkit/drives-microsoft` | **4 MB** | `createUploadSession` |
   * | `@basaltkit/drives-google` | **5 MB** | `uploadType=resumable` |
   * | `@basaltkit/drives-dropbox` | **150 MB** | `files/upload_session/*` |
   *
   * Anything larger is refused with {@link DriveContentTooLargeError} — **up
   * front** when {@link DriveUploadInput.size} is given, and mid-stream
   * otherwise. Nothing here silently truncates, and nothing here promises large
   * files; an app that needs them should upload to the provider itself for now.
   */
  upload?(session: DriveSession, input: DriveUploadInput): Promise<DriveItem>
  /** Establishes the initial delta cursor. See {@link deltaIncludesExisting}. */
  startDelta?(session: DriveSession, options: { folderId?: string | undefined }): Promise<string>
  /** Reads one page of changes since `cursor`. */
  delta?(session: DriveSession, cursor: string): Promise<DriveDelta>
  /**
   * Whether the cursor {@link startDelta} returns replays the items that
   * already exist, or only changes from that moment on.
   *
   * This is the difference the neutral cursor was flattening, and it decides
   * whether a first sync imports a tenant's drive or silently imports nothing:
   *
   * - **Dropbox — `true`.** `files/list_folder` *is* the head of the feed: its
   *   first page enumerates the folder and `/continue` carries on into changes.
   *   Backfill and delta are one continuum.
   * - **Google Drive — `false`.** `changes.getStartPageToken` is explicitly
   *   "from now"; the existing corpus never appears in `changes.list`.
   * - **Microsoft Graph — `true`.** `/delta` with no token enumerates the drive
   *   first, then hands over a `deltaLink`.
   *
   * Defaults to `false`, the safe direction: the engine runs one full listing
   * pass before the first delta run, so an adapter that forgets to declare it
   * costs extra metadata reads instead of losing a tenant's files.
   */
  readonly deltaIncludesExisting?: boolean
  /** Subscribes to push notifications. */
  watch?(session: DriveSession, input: DriveWatchInput): Promise<DriveWatch>
  /** Cancels a subscription. */
  unwatch?(session: DriveSession, watch: DriveWatch): Promise<void>
  /**
   * Verifies an inbound notification. **Pure and synchronous**: it gets no
   * session and no network, so verification cannot be turned into a request
   * amplifier by an unauthenticated caller hammering the webhook route.
   *
   * ## "Verified" is not one guarantee
   *
   * The engine treats every result the same way, and an app that reads
   * `shouldSync: true` cannot tell which of these produced it. They are not
   * equivalent, and the difference is the vendors', not this contract's:
   *
   * - **Dropbox — a real signature.** `X-Dropbox-Signature` is an HMAC-SHA256
   *   over the **raw body** under the app secret. It authenticates the message
   *   itself, which is what makes it safe for the engine to act on an
   *   {@link DriveNotificationResult.accountIds} lookup that necessarily spans
   *   tenants.
   * - **Google and Microsoft — a secret we chose**, echoed back
   *   (`X-Goog-Channel-Token`, Graph's `clientState`). Neither vendor signs
   *   anything. This authenticates the *subscription*, not the bytes: anyone
   *   holding the secret can send any body, and a body is not covered at all.
   *   That is why the engine matches such a result only against a connection
   *   that holds the subscription, and never across tenants.
   *
   * What makes the weaker one acceptable is not the secret, it is the blast
   * radius: **no vendor sends the changed data**. A verified notification only
   * ever causes the engine to go and ask the provider, with its own
   * credentials, for its own tenant. A perfect forgery costs a wasted sync.
   * Anything that changed that — a notification whose *content* was trusted —
   * would need the guarantees to be equalised first.
   */
  verifyNotification?(input: DriveNotificationInput): DriveNotificationResult
  /**
   * Reads a vendor-specific "slow down" hint out of a 429/503 body.
   *
   * `Retry-After` is the interoperable answer and always wins, but Dropbox
   * frequently answers `429` with no header at all and puts the number in the
   * body instead (`{"error":{".tag":"too_many_requests","retry_after":300}}`).
   * The guarded fetch destroys a rate-limited body before an adapter can see
   * it — deliberately, so nothing unbounded is read on an error path — so the
   * hint has to be declared here, where the engine can apply it under its own
   * cap.
   *
   * Returns milliseconds, or `undefined` when the body carries no hint. It must
   * be pure: it runs on a hostile-ish path and gets at most a few kilobytes.
   */
  retryAfterFromBody?(body: string): number | undefined
}

/**
 * One file to write back. See {@link DriveProvider.upload} for the per-adapter
 * size ceilings, which are **4 MB / 5 MB / 150 MB** and are not negotiable.
 */
export interface DriveUploadInput {
  name: string
  contentType: string
  /** The bytes. Streamed onto the socket and never buffered, at any size. */
  content: Readable
  /** Destination folder; defaults to the connection root. */
  folderId?: string | undefined
  /**
   * Length of {@link content} in bytes, when the caller knows it — and worth
   * knowing, because it is what moves the refusal of an oversized file from
   * *mid-stream* to *up front*.
   *
   * With it, an adapter compares against its own ceiling before it opens a
   * socket and throws {@link DriveContentTooLargeError} having sent nothing.
   * Without it the upload starts, the byte cap trips part-way through and the
   * request is destroyed — the same refusal, the same error, but after the
   * bytes have been on the wire. It is never trusted in place of the cap: a
   * source that under-reports its size is still caught by the bytes that
   * actually flow.
   */
  size?: number | undefined
}
