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

/** A digest the provider publishes for an item's content. */
export interface DriveChecksum {
  /** Lowercase algorithm name as the provider calls it: `md5`, `sha1`, `sha256`, `quickXor`, `dropboxContentHash`. */
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
  | { type: 'removed'; externalId: string }

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
  /** Secret the provider echoed back, for the engine to match against a connection. */
  secret?: string | undefined
  /** Provider subscription/channel id, when the notification carries one. */
  watchId?: string | undefined
  /** Whether this notification means "there is new work" (most are content-free pings). */
  changed: boolean
  /** Vendor id the notification is about, when it names one. Most vendors do not. */
  externalIds?: readonly string[] | undefined
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
  /** Writes a file back to the provider. Optional — most apps only read. */
  upload?(session: DriveSession, input: DriveUploadInput): Promise<DriveItem>
  /** Establishes the initial delta cursor ("everything from now on"). */
  startDelta?(session: DriveSession, options: { folderId?: string | undefined }): Promise<string>
  /** Reads one page of changes since `cursor`. */
  delta?(session: DriveSession, cursor: string): Promise<DriveDelta>
  /** Subscribes to push notifications. */
  watch?(session: DriveSession, input: DriveWatchInput): Promise<DriveWatch>
  /** Cancels a subscription. */
  unwatch?(session: DriveSession, watch: DriveWatch): Promise<void>
  /**
   * Verifies an inbound notification. **Pure and synchronous**: it gets no
   * session and no network, so verification cannot be turned into a request
   * amplifier by an unauthenticated caller hammering the webhook route.
   */
  verifyNotification?(input: DriveNotificationInput): DriveNotificationResult
}

export interface DriveUploadInput {
  name: string
  contentType: string
  content: Readable
  /** Destination folder; defaults to the connection root. */
  folderId?: string | undefined
  size?: number | undefined
}
