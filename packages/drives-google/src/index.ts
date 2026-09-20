import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  DriveAuthorizationInvalidError,
  DriveContentTooLargeError,
  DriveCredentialsInvalidError,
  DriveNotificationInvalidError,
  DriveProviderError,
  DriveUnsupportedError,
  capStream,
  type DriveAccount,
  type DriveAuthorization,
  type DriveAuthorizeInput,
  type DriveChange,
  type DriveContent,
  type DriveDelta,
  type DriveExchangeInput,
  type DriveItem,
  type DriveListOptions,
  type DriveNotificationInput,
  type DriveNotificationResult,
  type DrivePage,
  type DriveProvider,
  type DriveRefreshInput,
  type DriveSession,
  type DriveTokens,
  type DriveUploadInput,
  type DriveWatch,
  type DriveWatchInput,
  type GuardedFetch,
  type GuardedResponse,
} from '@basaltkit/drives'
import { googleFailure, toGoogleError } from './errors.js'
import { FILE_FIELDS, FOLDER_MIME, isNativeDoc, isRemoval, toDriveItem, type GoogleChange, type GoogleFile } from './metadata.js'

export { errorReason, googleFailure, toGoogleError, type GoogleFailureContext } from './errors.js'
export {
  FILE_FIELDS,
  FOLDER_MIME,
  NATIVE_MIME_PREFIX,
  SHORTCUT_MIME,
  isNativeDoc,
  isRemoval,
  toDriveItem,
  type GoogleChange,
  type GoogleFile,
} from './metadata.js'

/**
 * The Google Drive adapter.
 *
 * Written against Google's documented HTTP surface and tested against a
 * fetch-level fake of it, with no credentials and no network. Like every
 * adapter it is **translation**: it holds no credential store, never sees a
 * refresh token (the engine hands it one short-lived access token per call) and
 * never calls `fetch` — only `session.fetch`, which is host-allowlisted,
 * SSRF-validated, IP-pinned, byte-capped and timed out.
 *
 * ## Endpoints used
 *
 * | Capability | Google |
 * |---|---|
 * | consent | `accounts.google.com/o/oauth2/v2/auth` (browser only; never fetched) |
 * | token, refresh | `POST oauth2.googleapis.com/token` with `access_type=offline` |
 * | revoke | `POST oauth2.googleapis.com/revoke` |
 * | account | `GET /drive/v3/about?fields=user(...)` |
 * | list | `GET /drive/v3/files?q='<folder>' in parents and trashed = false` |
 * | metadata | `GET /drive/v3/files/{id}` |
 * | download | `GET /drive/v3/files/{id}?alt=media` — **302s to `*.googleusercontent.com`** |
 * | upload | `POST /upload/drive/v3/files?uploadType=multipart` (≤ 5 MB) |
 * | change feed | `changes.getStartPageToken` then `changes.list` |
 * | notifications | `changes.watch` / `channels.stop`, `X-Goog-Channel-Token` |
 *
 * ## The four things Google does not do the way phase 2a assumed
 *
 * 1. **`startDelta` means "from now on".** `changes.getStartPageToken` never
 *    replays what already exists, so this adapter declares
 *    `deltaIncludesExisting: false` and the engine runs a backfill listing pass
 *    before the first delta run. Declaring it wrong makes a connection's first
 *    sync import **nothing**, silently.
 * 2. **A throttle is a `403`.** See `errors.ts`.
 * 3. **`changes.list` is account-wide, not folder-scoped.** A connection
 *    confined to a `rootId` filters client-side — see
 *    {@link GoogleDrive.delta}.
 * 4. **Google-native documents have no bytes.** Docs, Sheets and Slides carry no
 *    `md5Checksum` and no `size`, and `alt=media` refuses them. They surface
 *    with `exportOnly: true` and `download` refuses them rather than exporting
 *    to a format the app never asked for.
 */

const API_HOST = 'www.googleapis.com'
const OAUTH_HOST = 'oauth2.googleapis.com'
/**
 * Where a download actually comes from.
 *
 * `files.get?alt=media` answers `302` to a signed, single-use URL on a
 * `*.googleusercontent.com` host. It is a **leading-dot suffix**, never the bare
 * parent: `.googleusercontent.com` matches `doc-0g-3s-docs.googleusercontent.com`
 * and refuses both `googleusercontent.com` itself and
 * `evilgoogleusercontent.com`, which a naive `endsWith` would wave through. The
 * guarded fetch re-validates the allowlist, the SSRF rules and the IP pin at
 * every hop, so the redirect target is treated as exactly what it is:
 * attacker-influenced data.
 */
const CDN_SUFFIX = '.googleusercontent.com'
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const API_BASE = `https://${API_HOST}/drive/v3`
const UPLOAD_BASE = `https://${API_HOST}/upload/drive/v3`
const TOKEN_URL = `https://${OAUTH_HOST}/token`
const REVOKE_URL = `https://${OAUTH_HOST}/revoke`

/**
 * Google's ceiling for a one-request upload.
 *
 * Both `uploadType=media` and `uploadType=multipart` stop here; anything larger
 * needs the three-call resumable protocol (`uploadType=resumable`), which has
 * its own session URI, its own 308-based resumability and its own failure modes.
 * Not implemented, and refused up front rather than after the bytes have been
 * sent — the same choice the Dropbox adapter makes at 150 MB.
 */
export const GOOGLE_SIMPLE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024
/** `files.list` and `changes.list` both refuse more than this. */
export const GOOGLE_MAX_PAGE_SIZE = 1000
/**
 * Longest channel TTL this adapter will ask for.
 *
 * Google caps a channel's life and answers with the `expiration` it actually
 * chose, which is what {@link DriveWatch.expiresAt} carries. Renewal is the
 * app's job — see the README's `defineReconciler` recipe — because a framework
 * that silently renewed a subscription would be making a traffic decision on
 * the app's behalf, for ever.
 */
export const GOOGLE_MAX_WATCH_TTL_MS = 7 * 24 * 60 * 60_000

/**
 * Drive file ids and the `root` alias, and nothing else.
 *
 * A `rootId` or `folderId` is interpolated into the `q` parameter, which is a
 * query language with string literals in it. Validating instead of escaping is
 * the fail-closed choice: a value that is not a file id has no business being
 * there, and a quote that slipped through an escape would widen a listing the
 * tenant scoped on purpose.
 */
const FILE_ID = /^[A-Za-z0-9_-]{1,512}$/

const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'] as const

export interface GoogleDriveOptions {
  /** OAuth client id from the Google Cloud console. */
  clientId: string
  /**
   * Client secret.
   *
   * Optional: a public client uses PKCE alone. Unlike Dropbox it is **not** a
   * webhook signing key — Google does not sign notifications at all, and
   * authenticates them with the `X-Goog-Channel-Token` the engine generated
   * per subscription.
   */
  clientSecret?: string
  /** Scopes to request. Default `drive.readonly`. */
  scopes?: readonly string[]
  /** `files.list` / `changes.list` page size. Clamped to 1…1000. Default 100. */
  pageSize?: number
  /**
   * How a listing treats a folder scope.
   *
   * - `'recursive'` (default) — the connection's `rootId`, and any explicit
   *   `folderId`, is walked **subtree-first**, because Drive has no recursive
   *   query and a top-level-only backfill would silently miss most of a
   *   tenant's documents. Matches the Dropbox adapter's `recursive: true`.
   * - `'children'` — one folder's direct children only, the shape a file
   *   browser wants. An import that uses it sees exactly one level.
   */
  listMode?: 'recursive' | 'children'
  /** Hard ceiling for one upload. Default — and maximum — 5 MB. */
  uploadMaxBytes?: number
  /** Channel TTL to request. Clamped to Google's maximum. Default 7 days. */
  watchTtlMs?: number
  /**
   * Report deletions that cannot be scoped to the connection's `rootId`.
   *
   * `changes.list` is account-wide. A hard deletion arrives as
   * `{fileId, removed: true}` with **no file resource**, so for a root-scoped
   * connection there is nothing left to test the ancestry of. Default `false`:
   * such a change is dropped, because forwarding it would put an id from
   * outside the connection's folder into `onRemoved`, the app's hooks and any
   * ledger lookup they drive. Set it to `true` to receive them anyway and
   * correlate against your own ledger — see the README.
   */
  includeUnscopedRemovals?: boolean
  /** Ancestry hops a scope check may walk. Default 32. */
  ancestryMaxDepth?: number
  /** Metadata reads one `delta` call may spend on ancestry. Default 500. */
  ancestryMaxLookups?: number
  /** Injected clock (tests). */
  now?: () => number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface ChangesResponse {
  changes?: GoogleChange[]
  nextPageToken?: string
  newStartPageToken?: string
}

/** The adapter. Construct it with {@link googleDrive}. */
export class GoogleDrive implements DriveProvider {
  readonly name = 'google'
  /**
   * The SSRF allowlist.
   *
   * `accounts.google.com` is **not** on it: the consent URL is handed to a
   * browser and never fetched by the framework, so allowing the host would
   * widen the guard for nothing. `.googleusercontent.com` is on it because the
   * download redirect genuinely lands there — see {@link CDN_SUFFIX}.
   */
  readonly allowedHosts: readonly string[] = [API_HOST, OAUTH_HOST, CDN_SUFFIX]
  /**
   * **`false`, and this is the single most consequential line in the adapter.**
   *
   * `changes.getStartPageToken` is documented as the token for "the start of
   * the *future*": the corpus that already exists never appears in
   * `changes.list`. With `true` — or with the field left off against an engine
   * that defaulted the other way — a connection's first sync would walk an
   * empty change feed, report success, import nothing, and persist a cursor
   * that guarantees the existing files are never seen again.
   *
   * With `false` the engine takes the start token first, then runs a full
   * listing pass, then switches to the feed. The ordering is the correctness
   * argument: anything that changes during the listing is re-delivered by the
   * first delta run, which is at-least-once and the ledger absorbs it.
   */
  readonly deltaIncludesExisting = false
  readonly authorization: DriveAuthorization

  private readonly pageSize: number
  private readonly uploadMaxBytes: number
  private readonly watchTtlMs: number
  private readonly scopes: readonly string[]
  private readonly ancestryMaxDepth: number
  private readonly ancestryMaxLookups: number
  private readonly now: () => number

  constructor(private readonly options: GoogleDriveOptions) {
    if (!options.clientId) throw new TypeError('googleDrive(): `clientId` is required.')
    this.pageSize = Math.min(Math.max(1, options.pageSize ?? 100), GOOGLE_MAX_PAGE_SIZE)
    this.uploadMaxBytes = Math.min(options.uploadMaxBytes ?? GOOGLE_SIMPLE_UPLOAD_MAX_BYTES, GOOGLE_SIMPLE_UPLOAD_MAX_BYTES)
    this.watchTtlMs = Math.min(Math.max(60_000, options.watchTtlMs ?? GOOGLE_MAX_WATCH_TTL_MS), GOOGLE_MAX_WATCH_TTL_MS)
    this.scopes = options.scopes ?? DEFAULT_SCOPES
    this.ancestryMaxDepth = Math.max(1, options.ancestryMaxDepth ?? 32)
    this.ancestryMaxLookups = Math.max(0, options.ancestryMaxLookups ?? 500)
    this.now = options.now ?? Date.now
    this.authorization = this.buildAuthorization()
  }

  // ------------------------------------------------------------------ OAuth

  private buildAuthorization(): DriveAuthorization {
    return {
      /**
       * The consent URL. Pure — no I/O, and deliberately not fetched by
       * anything in this package.
       *
       * Three parameters are load-bearing:
       *
       * - `access_type=offline` is what makes Google return a refresh token at
       *   all. Without it the grant lasts an hour and the connection dies.
       * - `prompt=consent` is what makes it return one *again* for a user who
       *   has already authorized the app. Google issues a refresh token only on
       *   the first consent, so an app that omits this gets `refresh_token`
       *   exactly once, and every later reconnect produces a connection that is
       *   already broken.
       * - PKCE S256, always, even for a confidential client. It costs nothing
       *   and removes the authorization-code interception class outright.
       */
      authorizeUrl: (input: DriveAuthorizeInput): string => {
        const url = new URL(AUTHORIZE_URL)
        url.searchParams.set('client_id', this.options.clientId)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('redirect_uri', input.redirectUri)
        url.searchParams.set('state', input.state)
        url.searchParams.set('access_type', 'offline')
        url.searchParams.set('prompt', 'consent')
        url.searchParams.set('include_granted_scopes', 'true')
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        const scopes = input.scopes ?? this.scopes
        if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '))
        return url.toString()
      },

      exchange: async (input: DriveExchangeInput): Promise<DriveTokens> => {
        const json = await this.token(input.fetch, {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        })
        if (json.error !== undefined || json.access_token === undefined) {
          // `error_description` is free text and is not forwarded; the code is
          // a fixed vocabulary and is.
          throw new DriveAuthorizationInvalidError(`Google refused the code (${json.error ?? 'no access_token'}).`)
        }
        if (json.refresh_token === undefined) {
          // Google omits it when the user had already consented and the
          // authorization did not force a fresh consent. Refusing here is
          // better than storing a connection that works for an hour and then
          // has no way back.
          throw new DriveAuthorizationInvalidError(
            'Google returned no refresh token; the authorization must request `access_type=offline` and `prompt=consent`.',
          )
        }
        return this.tokensFrom(json)
      },

      /**
       * Google does **not** rotate refresh tokens: a refresh response carries a
       * new access token and nothing else. The engine keeps the stored refresh
       * token when a provider omits one, which is exactly right here.
       *
       * The `invalid_grant` branch is the uncomfortable one. Google answers it
       * for a consent the user revoked, for a project whose OAuth client was
       * deleted, **and** for a grant that simply went unused for six months (or
       * seven days, while the app is in "testing"). Those are the same string on
       * the wire, so the contract cannot distinguish them and this adapter does
       * not pretend to: all of them mean "the tenant must reconnect", which is
       * the only action available in any of the three cases.
       */
      refresh: async (input: DriveRefreshInput): Promise<DriveTokens> => {
        const json = await this.token(input.fetch, {
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
        })
        if (json.error === 'invalid_grant') {
          throw new DriveCredentialsInvalidError(
            'google',
            'Google rejected the refresh token (invalid_grant): the consent was revoked, or the grant expired from disuse.',
          )
        }
        if (json.error !== undefined || json.access_token === undefined) {
          // `invalid_client`, `unauthorized_client` and friends are OUR
          // misconfiguration, not the tenant's revocation. Failing generically
          // keeps a deployment mistake from logging every tenant out of their
          // drive.
          throw new Error(`google: token refresh failed (${json.error ?? 'no access_token'})`)
        }
        return this.tokensFrom(json)
      },

      /**
       * Revoking the **refresh** token revokes the whole grant, which is what
       * "disconnect" is supposed to mean; revoking only the access token would
       * leave the grant alive and merely make it invisible to us.
       */
      revoke: async ({ tokens, fetch }: { tokens: DriveTokens; fetch: GuardedFetch }): Promise<void> => {
        const response = await fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }).toString(),
          maxBytes: 64 * 1024,
        })
        response.destroy()
      },

      /**
       * `about.get` rather than the userinfo endpoint, so the adapter needs no
       * profile scope beyond the Drive one it already has.
       *
       * `permissionId` is the account handle Drive itself uses, and it is what
       * `DriveConnectionAccount.id` stores. Google notifications identify a
       * connection by the channel token we chose, so — unlike Dropbox — nothing
       * here is load-bearing for webhook correlation; it is display data and
       * duplicate detection.
       */
      account: async (session: DriveSession): Promise<DriveAccount> => {
        const json = await this.call<{ user?: { displayName?: string; emailAddress?: string; permissionId?: string } }>(
          session,
          `${API_BASE}/about?fields=${encodeURIComponent('user(displayName,emailAddress,permissionId)')}`,
        )
        const user = json.user ?? {}
        return {
          ...(user.permissionId !== undefined ? { id: user.permissionId } : {}),
          ...(user.emailAddress !== undefined ? { email: user.emailAddress } : {}),
          ...(user.displayName !== undefined ? { name: user.displayName } : {}),
        }
      },
    }
  }

  // ------------------------------------------------------------- operations

  /**
   * One page of a listing.
   *
   * Drive has **no recursive query**. `'<id>' in parents` returns a folder's
   * direct children and nothing deeper, and there is no `under:` operator to
   * ask for a subtree — so an adapter that stopped there would give a
   * `rootId`-scoped connection a backfill containing only the top level, while
   * the change feed (which is account-wide, and filtered by ancestry) happily
   * delivered the subfolders' files afterwards. The first sync would silently
   * miss most of a tenant's documents and the second would look like it was
   * inventing them.
   *
   * So a scoped listing **walks**: one folder at a time, pushing the folders it
   * finds onto a queue carried inside the cursor. The cursor is opaque to
   * everything above the adapter by contract, which is what makes this legal
   * rather than a hack, and the walk costs no extra metadata reads — every
   * folder is discovered as a child of one already being read. An unscoped
   * connection needs none of it: `trashed = false` with no parent clause
   * enumerates the whole account in one flat, natively-paginated feed.
   *
   * `listMode: 'children'` turns the walk off for apps that are browsing rather
   * than importing.
   */
  async list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    const scope = options.folderId ?? session.rootId
    const limit = Math.min(Math.max(1, options.limit ?? this.pageSize), GOOGLE_MAX_PAGE_SIZE)
    if (scope === undefined || this.options.listMode === 'children') {
      const page = await this.listPage(session, scope, limit, options.cursor)
      return {
        items: page.files.map(toDriveItem),
        ...(page.nextPageToken !== undefined ? { cursor: page.nextPageToken } : {}),
      }
    }

    const state = decodeWalk(options.cursor) ?? {
      current: scope,
      pending: [],
      ...(options.cursor !== undefined ? { token: options.cursor } : {}),
    }
    const page = await this.listPage(session, state.current, limit, state.token)
    const items = page.files.map(toDriveItem)
    const pending = [...state.pending, ...page.files.filter((file) => file.mimeType === FOLDER_MIME && file.id !== undefined).map((file) => file.id as string)]

    let next: WalkState | undefined
    if (page.nextPageToken !== undefined) {
      next = { current: state.current, pending, token: page.nextPageToken }
    } else if (pending.length > 0) {
      next = { current: pending[0] as string, pending: pending.slice(1) }
    }
    return { items, ...(next !== undefined ? { cursor: encodeWalk(next) } : {}) }
  }

  /** One `files.list` page: either a folder's direct children, or the whole account. */
  private async listPage(
    session: DriveSession,
    folderId: string | undefined,
    limit: number,
    pageToken: string | undefined,
  ): Promise<{ files: GoogleFile[]; nextPageToken?: string | undefined }> {
    const params = new URLSearchParams({
      // `trashed = false` matters more than it looks: without it a listing
      // re-imports everything the tenant has deleted but not yet purged.
      q: folderId === undefined ? 'trashed = false' : `${quoteId(folderId)} in parents and trashed = false`,
      pageSize: String(limit),
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      // Recommended on every request: without it an id that lives in a shared
      // drive is simply not found, which looks like a permissions bug.
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      spaces: 'drive',
    })
    if (pageToken !== undefined) params.set('pageToken', pageToken)
    const json = await this.call<{ files?: GoogleFile[]; nextPageToken?: string }>(
      session,
      `${API_BASE}/files?${params.toString()}`,
    )
    return {
      files: json.files ?? [],
      ...(json.nextPageToken !== undefined ? { nextPageToken: json.nextPageToken } : {}),
    }
  }

  async get(session: DriveSession, externalId: string): Promise<DriveItem | null> {
    const response = await this.request(
      session,
      `${API_BASE}/files/${encodeURIComponent(externalId)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
    )
    if (!response.ok) {
      const body = await response.text()
      const error = toGoogleError(response.status, body, {
        provider: this.name,
        connectionId: session.connectionId,
        externalId,
      })
      // The contract says a missing item is `null`, not an error: an import job
      // for a file someone deleted mid-sync is not a failure worth retrying.
      if ((error as { code?: string }).code === 'DRIVE_ITEM_NOT_FOUND') return null
      throw error
    }
    return toDriveItem((await response.json()) as GoogleFile)
  }

  /**
   * Opens an item's bytes.
   *
   * Streamed, never buffered. The interesting part is the hop: `alt=media`
   * answers `302` to a signed URL on `*.googleusercontent.com`, and the guarded
   * fetch re-runs the host allowlist, the SSRF validation and the IP pin on
   * that target before a byte moves. The adapter never sees the signed URL and
   * therefore cannot log it, which matters because that URL **is** a bearer
   * credential for the file.
   */
  async download(session: DriveSession, item: DriveItem): Promise<DriveContent> {
    if (item.exportOnly === true || isNativeDoc(item.contentType)) {
      // A Google-native document has no bytes to hand over. `files.export`
      // could produce some, but only by choosing a format — PDF? DOCX? — that
      // the app never asked for, and an import ledger keyed on a checksum that
      // does not exist would call the result "unchanged" for ever. Refusing
      // loudly is the honest answer; the README shows how an app that wants an
      // export can do it in its own sink.
      throw new DriveUnsupportedError(
        this.name,
        `downloading the Google-native document "${item.name}" (use files.export to choose a format)`,
      )
    }
    if (item.kind === 'folder') {
      throw new DriveUnsupportedError(this.name, `downloading the folder "${item.name}"`)
    }
    const response = await this.request(
      session,
      `${API_BASE}/files/${encodeURIComponent(item.externalId)}?alt=media&supportsAllDrives=true`,
      // The guarded fetch's default `accept: application/json` would be a lie
      // here, and some proxies act on it.
      { accept: '*/*' },
    )
    if (!response.ok) {
      await googleFailure(response, {
        provider: this.name,
        connectionId: session.connectionId,
        externalId: item.externalId,
      })
    }
    const declared = response.headers['content-type']
    const length = Number(response.headers['content-length'])
    return {
      stream: response.body,
      ...(declared !== undefined ? { contentType: declared } : item.contentType !== undefined ? { contentType: item.contentType } : {}),
      ...(Number.isFinite(length) && length >= 0 ? { size: length } : item.size !== undefined ? { size: item.size } : {}),
    }
  }

  /**
   * Single-request multipart upload.
   *
   * The metadata part and the bytes are **streamed** in one body rather than
   * assembled in memory: a multipart upload that buffered its payload would
   * hold the whole file per concurrent job, which is how an import pipeline
   * takes a process down. The cap is enforced on the bytes that actually flow,
   * so a source that lies about its size is caught mid-stream.
   *
   * Anything over 5 MB is refused up front with `DRIVE_CONTENT_TOO_LARGE`:
   * `uploadType=resumable` is a documented limitation, not a silent one.
   */
  async upload(session: DriveSession, input: DriveUploadInput): Promise<DriveItem> {
    if (input.size !== undefined && input.size > this.uploadMaxBytes) {
      input.content.destroy()
      throw new DriveContentTooLargeError(this.uploadMaxBytes)
    }
    const folder = input.folderId ?? session.rootId
    const metadata: Record<string, unknown> = { name: input.name, mimeType: input.contentType }
    if (folder !== undefined) metadata['parents'] = [assertFileId(folder)]

    const boundary = `basalt-${randomUUID()}`
    const params = new URLSearchParams({
      uploadType: 'multipart',
      supportsAllDrives: 'true',
      fields: FILE_FIELDS,
    })
    const response = await session.fetch(`${UPLOAD_BASE}/files?${params.toString()}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody(boundary, metadata, capStream(input.content, this.uploadMaxBytes), input.contentType),
      ...(session.signal ? { signal: session.signal } : {}),
    })
    if (!response.ok) {
      await googleFailure(response, { provider: this.name, connectionId: session.connectionId })
    }
    return toDriveItem((await response.json()) as GoogleFile)
  }

  /**
   * The start token — "everything from **now** on".
   *
   * `folderId` is accepted and ignored, because Google's change feed has no
   * folder scope: there is one feed per account (or per shared drive). The
   * filtering a `rootId` connection needs therefore happens in {@link delta},
   * client-side, and the README says what that costs.
   */
  async startDelta(session: DriveSession, _options: { folderId?: string | undefined }): Promise<string> {
    const json = await this.call<{ startPageToken?: string }>(
      session,
      `${API_BASE}/changes/startPageToken?supportsAllDrives=true`,
    )
    if (json.startPageToken === undefined) throw new Error('google: changes.getStartPageToken returned no token')
    return json.startPageToken
  }

  /**
   * One page of the change feed.
   *
   * Two things make this the least mechanical method in the adapter:
   *
   * **The feed is account-wide.** A connection confined to a `rootId` sees every
   * change in the user's Drive, so each one is scope-checked by walking its
   * ancestry (`parents`, then a metadata read per unseen folder, cached for the
   * duration of this one call). Out-of-scope changes are dropped **before** they
   * become a `DriveChange`, so nothing about another folder reaches `onRemoved`,
   * the hooks or the ledger.
   *
   * **A hard deletion carries no file resource.** `{fileId, removed: true}` is
   * all there is, so for a scoped connection there is nothing to test the
   * ancestry of. Those are dropped by default (see
   * {@link GoogleDriveOptions.includeUnscopedRemovals}); the ordinary Drive
   * delete — a trash — arrives as a full resource with `trashed: true` and is
   * scoped like anything else.
   */
  async delta(session: DriveSession, cursor: string): Promise<DriveDelta> {
    const params = new URLSearchParams({
      pageToken: cursor,
      pageSize: String(this.pageSize),
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,changeType,file(${FILE_FIELDS}))`,
      includeRemoved: 'true',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      spaces: 'drive',
    })
    const json = await this.call<ChangesResponse>(session, `${API_BASE}/changes?${params.toString()}`, {
      cursor: true,
    })

    const scope = new ScopeCheck(this, session, this.ancestryMaxDepth, this.ancestryMaxLookups)
    const changes: DriveChange[] = []
    for (const change of json.changes ?? []) {
      // `changeType: 'drive'` is a shared-drive metadata change and names no
      // file at all.
      if (change.fileId === undefined || change.changeType === 'drive') continue
      if (isRemoval(change)) {
        const file = change.file
        if (file === undefined) {
          // Unscopable: no parents, no name, nothing. Dropping it is the
          // non-leaking direction; `includeUnscopedRemovals` is the opt-in.
          if (session.rootId !== undefined && this.options.includeUnscopedRemovals !== true) continue
        } else if (!(await scope.contains(file))) {
          continue
        }
        changes.push({ type: 'removed', externalId: change.fileId })
        continue
      }
      const file = change.file
      if (file === undefined) continue
      if (!(await scope.contains(file))) continue
      changes.push({ type: 'upserted', item: toDriveItem(file) })
    }

    // `nextPageToken` while there is more of this page-run; `newStartPageToken`
    // on the last page, which is the token the *next* run resumes from.
    const next = json.nextPageToken ?? json.newStartPageToken
    if (next === undefined) {
      // Without a cursor there is nothing to resume from, and pretending
      // otherwise would silently restart the feed on every run.
      throw new Error('google: changes.list returned neither nextPageToken nor newStartPageToken')
    }
    return { changes, cursor: next, hasMore: json.nextPageToken !== undefined }
  }

  /**
   * Registers a `changes.watch` channel.
   *
   * The channel id is ours (a UUID) and so is the token: the engine generates
   * one random secret per subscription and Google echoes it back in
   * `X-Goog-Channel-Token`, which is the **only** thing authenticating an
   * inbound notification — Google does not sign them.
   *
   * `resourceId` comes back from Google and is the other half of what
   * `channels.stop` needs, so it is persisted in {@link DriveWatch.raw}.
   * `resourceUri` is deliberately **not** persisted: it embeds the page token,
   * and a URL that grants access to a feed does not belong in a row that gets
   * read for display.
   */
  async watch(session: DriveSession, input: DriveWatchInput): Promise<DriveWatch> {
    const url = new URL(input.notificationUrl)
    if (url.protocol !== 'https:') {
      throw new TypeError('googleDrive(): the notification URL must be https — Google refuses anything else.')
    }
    const pageToken = await this.startDelta(session, {})
    const ttl = Math.min(input.ttlMs ?? this.watchTtlMs, this.watchTtlMs)
    const channelId = randomUUID()
    const json = await this.call<{ id?: string; resourceId?: string; expiration?: string }>(
      session,
      `${API_BASE}/changes/watch?pageToken=${encodeURIComponent(pageToken)}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      {
        body: {
          id: channelId,
          type: 'web_hook',
          address: input.notificationUrl,
          token: input.secret,
          params: { ttl: String(Math.floor(ttl / 1000)) },
        },
      },
    )
    // Google's own `expiration` wins over the TTL we asked for: it caps the
    // life of a channel, and believing our own number is how an app renews too
    // late and silently stops receiving notifications.
    const expiration = Number(json.expiration)
    return {
      id: json.id ?? channelId,
      ...(Number.isFinite(expiration) && expiration > 0 ? { expiresAt: expiration } : { expiresAt: this.now() + ttl }),
      ...(json.resourceId !== undefined ? { raw: { resourceId: json.resourceId } } : {}),
    }
  }

  async unwatch(session: DriveSession, watch: DriveWatch): Promise<void> {
    const resourceId = watch.raw?.['resourceId']
    if (typeof resourceId !== 'string' || resourceId === '') {
      throw new DriveProviderError(this.name, 'missingResourceId', 400, false)
    }
    const response = await this.request(session, `${API_BASE}/channels/stop`, undefined, {
      id: watch.id,
      resourceId,
    })
    if (!response.ok) {
      await googleFailure(response, { provider: this.name, connectionId: session.connectionId })
    }
    response.destroy()
  }

  /**
   * Verifies an inbound notification.
   *
   * Google sends no body worth reading and no signature at all: a notification
   * is a set of `X-Goog-*` headers, and the `X-Goog-Channel-Token` we chose at
   * subscribe time is the whole of the authentication. So this method is a
   * constant-time comparison's worth of work, performed by the engine against
   * the connection's stored secret — the adapter only extracts and bounds the
   * values.
   *
   * The `sync` state is the "channel established" message Google sends
   * immediately after `changes.watch`. It is authentic and means nothing has
   * changed yet, so it comes back `changed: false` and the engine answers it
   * with the same 200 as everything else.
   */
  verifyNotification(input: DriveNotificationInput): DriveNotificationResult {
    if (input.method.toUpperCase() !== 'POST') {
      // Google has no GET handshake — it verifies the domain out of band, in
      // the Cloud console. Anything else arriving here is not a notification.
      throw new DriveNotificationInvalidError('Google notifications are POSTs.')
    }
    const token = input.headers['x-goog-channel-token']
    if (token === undefined || token === '') {
      // Fail closed. Without the channel token there is nothing that
      // authenticates this call, and accepting it would hand an
      // unauthenticated caller a sync trigger for a connection it names.
      throw new DriveNotificationInvalidError('the notification carried no channel token.')
    }
    if (token.length > 256) throw new DriveNotificationInvalidError('the channel token is too long.')
    const channelId = input.headers['x-goog-channel-id']
    const state = input.headers['x-goog-resource-state']
    return {
      secret: token,
      changed: state !== 'sync',
      ...(channelId !== undefined && channelId !== '' ? { watchId: channelId } : {}),
    }
  }

  // ----------------------------------------------------------------- guts

  /**
   * Fetches a file's parents.
   *
   * Deliberately a separate, minimal field mask: a scope check needs the graph,
   * not the file, and asking for a name it is going to discard would put a
   * folder title from outside the connection's root into this process for no
   * reason.
   *
   * @internal used by {@link ScopeCheck}.
   */
  async parentsOf(session: DriveSession, fileId: string): Promise<string[]> {
    const response = await this.request(
      session,
      `${API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,parents&supportsAllDrives=true`,
    )
    if (!response.ok) {
      const body = await response.text()
      const error = toGoogleError(response.status, body, {
        provider: this.name,
        connectionId: session.connectionId,
        externalId: fileId,
      })
      // A parent we cannot read is a parent we cannot claim is in scope. Fail
      // closed rather than failing the whole page.
      if ((error as { code?: string }).code === 'DRIVE_ITEM_NOT_FOUND') return []
      if ((error as { code?: string }).code === 'DRIVE_ACCESS_DENIED') return []
      throw error
    }
    const json = (await response.json()) as GoogleFile
    return json.parents ?? []
  }

  /** One JSON call, mapped on failure. */
  private async call<T>(
    session: DriveSession,
    url: string,
    options: { cursor?: boolean; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.request(session, url, undefined, options.body)
    if (!response.ok) {
      await googleFailure(response, {
        provider: this.name,
        connectionId: session.connectionId,
        ...(options.cursor === true ? { cursor: true } : {}),
      })
    }
    return (await response.json()) as T
  }

  private async request(
    session: DriveSession,
    url: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<GuardedResponse> {
    return session.fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A metadata call has no business reading megabytes; the download cap is
      // a separate, much larger number.
      maxBytes: 8 * 1024 * 1024,
      ...(session.signal ? { signal: session.signal } : {}),
    })
  }

  /**
   * The token endpoint.
   *
   * Goes through the **guarded** fetch like everything else: a token exchange
   * is as much an SSRF and timeout surface as a download, and it is the one
   * call that carries the client secret.
   */
  private async token(fetch: GuardedFetch, fields: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams({ ...fields, client_id: this.options.clientId })
    if (this.options.clientSecret !== undefined) form.set('client_secret', this.options.clientSecret)
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      maxBytes: 64 * 1024,
    })
    // OAuth errors arrive as 400 with a JSON body, so the body is read for
    // every status rather than only the happy one.
    try {
      return (await response.json<TokenResponse>()) ?? {}
    } catch {
      response.destroy()
      return { error: `http_${response.status}` }
    }
  }

  private tokensFrom(json: TokenResponse): DriveTokens {
    return {
      accessToken: json.access_token as string,
      ...(json.expires_in !== undefined ? { expiresAt: this.now() + json.expires_in * 1000 } : {}),
      ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
      ...(json.scope !== undefined ? { scopes: json.scope.split(' ').filter(Boolean) } : {}),
    }
  }
}

/**
 * Builds the Google Drive adapter.
 *
 * ```ts
 * drivesPlugin({
 *   providers: [googleDrive({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET })],
 *   keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
 *   secret: env.APP_SECRET,
 * })
 * ```
 */
export function googleDrive(options: GoogleDriveOptions): GoogleDrive {
  return new GoogleDrive(options)
}

/**
 * Answers "is this file inside the connection's root?", once per `delta` call.
 *
 * The cache lives for exactly one call and is keyed by file id, so it can never
 * carry an answer from one connection (or one tenant) into another: a new
 * instance is built per page, and a `DriveSession` is per connection by
 * construction. A shared, longer-lived cache would be faster and would be a
 * cross-tenant leak waiting for a collision.
 */
class ScopeCheck {
  private readonly parents = new Map<string, string[]>()
  private lookups = 0

  constructor(
    private readonly drive: GoogleDrive,
    private readonly session: DriveSession,
    private readonly maxDepth: number,
    private readonly maxLookups: number,
  ) {}

  async contains(file: GoogleFile): Promise<boolean> {
    const root = this.session.rootId
    if (root === undefined) return true
    if (file.id === root) return true
    let frontier = file.parents ?? []
    if (file.id !== undefined) this.parents.set(file.id, frontier)
    const seen = new Set<string>(file.id !== undefined ? [file.id] : [])

    for (let depth = 0; depth < this.maxDepth && frontier.length > 0; depth++) {
      if (frontier.includes(root)) return true
      const next: string[] = []
      for (const parent of frontier) {
        if (seen.has(parent)) continue
        seen.add(parent)
        next.push(...(await this.lookup(parent)))
      }
      frontier = next
    }
    return false
  }

  private async lookup(fileId: string): Promise<string[]> {
    const cached = this.parents.get(fileId)
    if (cached !== undefined) return cached
    if (++this.lookups > this.maxLookups) {
      // Loud rather than silent: guessing in either direction is wrong — "in
      // scope" leaks another folder's metadata, "out of scope" loses a tenant's
      // file — so the run fails and `ancestryMaxLookups` is the knob.
      throw new DriveProviderError('google', 'ancestryLookupBudgetExhausted', 507, false)
    }
    const parents = await this.drive.parentsOf(this.session, fileId)
    this.parents.set(fileId, parents)
    return parents
  }
}

/**
 * Validates a Drive file id before it is interpolated into a `q` expression.
 *
 * See {@link FILE_ID}: escaping would be the tempting alternative, and a single
 * missed quote in an escape widens a listing the tenant deliberately scoped.
 */
function assertFileId(value: string): string {
  if (!FILE_ID.test(value)) {
    throw new TypeError(`googleDrive(): "${value.slice(0, 32)}" is not a Google Drive file id.`)
  }
  return value
}

function quoteId(value: string): string {
  return `'${assertFileId(value)}'`
}

/**
 * Where a recursive listing has got to: the folder being read, its page token,
 * and the folders discovered but not yet visited.
 */
interface WalkState {
  current: string
  pending: string[]
  token?: string | undefined
}

/** Marks a cursor as this adapter's walk state rather than a Google page token. */
const WALK_PREFIX = 'gwalk1.'

function encodeWalk(state: WalkState): string {
  return `${WALK_PREFIX}${Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')}`
}

/**
 * Decodes a walk cursor, or `null` for anything that is not one.
 *
 * `null` rather than a throw, because a cursor handed back to this adapter may
 * legitimately be a plain Google page token — an app that listed with
 * `listMode: 'children'` and then switched, or a stored cursor from an older
 * version. Falling back to "treat it as a page token for the scope folder" is
 * a correct, cheap recovery; throwing would strand a connection on a value it
 * has already persisted.
 */
function decodeWalk(cursor: string | undefined): WalkState | null {
  if (cursor === undefined || !cursor.startsWith(WALK_PREFIX)) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(WALK_PREFIX.length), 'base64url').toString('utf8')) as WalkState
    if (typeof parsed?.current !== 'string' || !Array.isArray(parsed.pending)) return null
    return {
      current: assertFileId(parsed.current),
      pending: parsed.pending.filter((id): id is string => typeof id === 'string').map(assertFileId),
      ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
    }
  } catch {
    return null
  }
}

/**
 * A `multipart/related` body, streamed.
 *
 * The metadata part goes out first so Google can name and place the file, then
 * the bytes flow through untouched. Nothing is concatenated in memory, so a
 * concurrent import pipeline costs one socket per upload rather than one copy
 * of every file.
 */
function multipartBody(
  boundary: string,
  metadata: Record<string, unknown>,
  content: Readable,
  contentType: string,
): Readable {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Readable.from(
    (async function* () {
      yield head
      for await (const chunk of content) yield chunk as Buffer
      yield tail
    })(),
  )
  // The generator does not start — and so does not listen — until the socket
  // pulls the first chunk, while the byte cap can trip the moment the source
  // begins flowing. Forwarding here means the capped stream always has an error
  // listener, so an oversized upload fails the request instead of surfacing as
  // an unhandled `error` event on a stream nobody is watching yet.
  content.once('error', (error: Error) => body.destroy(error))
  return body
}
