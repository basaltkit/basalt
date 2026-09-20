import {
  DriveAuthorizationInvalidError,
  DriveContentTooLargeError,
  DriveCredentialsInvalidError,
  DriveItemNotFoundError,
  DriveNotificationInvalidError,
  DriveUnsupportedError,
  capStream,
  verifyHmacSignature,
  type DriveAccount,
  type DriveAuthorization,
  type DriveAuthorizeInput,
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
  type GuardedFetch,
  type GuardedResponse,
} from '@basaltkit/drives'
import { dropboxFailure, retryAfterFromBody, toDropboxError } from './errors.js'
import { apiArg, dropboxPath, toDriveChange, toDriveItem, type DropboxEntry } from './metadata.js'

/**
 * The Dropbox adapter — the first real implementation of the
 * `@basaltkit/drives` contract, and the one that validates it.
 *
 * Dropbox was chosen first deliberately (RFC 0002 §9): it is the only one of
 * the three targets that actually **signs** its notifications, so it exercises
 * the hostile half of the design rather than the comfortable half.
 *
 * ## What this adapter is, and is not
 *
 * It is translation. It holds no credential store, never sees a refresh token
 * (the engine hands it one short-lived access token per call), and never calls
 * `fetch` — only `session.fetch`, which is host-allowlisted, SSRF-validated,
 * IP-pinned, byte-capped and timed out. Everything that looks like policy
 * (retry, backoff, dedup, tenancy, encryption at rest) lives above it.
 *
 * ## Endpoints used
 *
 * | Capability | Dropbox |
 * |---|---|
 * | consent | `https://www.dropbox.com/oauth2/authorize` (browser only; never fetched) |
 * | token, refresh | `POST /oauth2/token` with `token_access_type=offline` |
 * | revoke | `POST /2/auth/token/revoke` |
 * | account | `POST /2/users/get_current_account` |
 * | list | `POST /2/files/list_folder` + `/continue` |
 * | metadata | `POST /2/files/get_metadata` |
 * | download | `POST https://content.dropboxapi.com/2/files/download`, arg in `Dropbox-API-Arg` |
 * | upload | `POST https://content.dropboxapi.com/2/files/upload` (single shot, ≤ 150 MB) |
 * | change feed | the same `list_folder` cursor — see {@link DropboxDrive.startDelta} |
 * | notifications | app-wide webhook, `X-Dropbox-Signature` over the raw body |
 *
 * ## Known limitations
 *
 * - **Uploads over 150 MB are not supported.** They need
 *   `files/upload_session/{start,append_v2,finish}`, which is a three-call
 *   protocol with its own resumability story; single-shot `files/upload`
 *   refuses anything larger and so does this adapter, up front, with
 *   `DRIVE_CONTENT_TOO_LARGE` rather than after sending the bytes.
 * - **Dropbox Business team spaces are not addressed.** `Dropbox-API-Path-Root`
 *   and `Dropbox-API-Select-User` are not sent, so a connection acts in the
 *   member's own space.
 * - **Export-only items are reported, not exported.** Paper docs surface with
 *   `exportOnly: true`; `files/export` is not wired.
 * - **No `externalUrl`.** Dropbox metadata carries no web link, and
 *   manufacturing one would mean creating a share.
 */

const API_HOST = 'api.dropboxapi.com'
const CONTENT_HOST = 'content.dropboxapi.com'
const NOTIFY_HOST = 'notify.dropboxapi.com'
const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize'

/** Dropbox's own ceiling for a single-shot `files/upload`. */
export const DROPBOX_SINGLE_UPLOAD_MAX_BYTES = 150 * 1024 * 1024
/** `list_folder` refuses more than this. */
export const DROPBOX_MAX_PAGE_SIZE = 2000
/**
 * Marks "the feed has not started yet".
 *
 * Dropbox has no way to hand back a cursor positioned at the *beginning* of a
 * folder: `files/list_folder` returns the first page **and** the cursor, and
 * `get_latest_cursor` skips everything that already exists. So `startDelta`
 * returns this synthetic value, and the first `delta` call turns it into the
 * `list_folder` that produces both the entries and the real cursor. The cursor
 * is opaque to the engine by contract, which is what makes this legal rather
 * than a hack — and it is why Dropbox can declare
 * `deltaIncludesExisting: true` honestly.
 */
const START_CURSOR = 'basalt.dropbox.start:'

const DEFAULT_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read'] as const

export interface DropboxDriveOptions {
  /** App key from the Dropbox App Console. */
  clientId: string
  /**
   * App secret.
   *
   * Optional: a public client uses PKCE alone. When present it is also the
   * default webhook signing key, because Dropbox signs notifications with the
   * app secret — there is no separate webhook secret to configure, and no
   * per-connection secret at all.
   */
  clientSecret?: string
  /** Overrides the webhook signing key. Only needed if the app secret is held elsewhere. */
  webhookSecret?: string
  /** Scopes to request. Default: read-only metadata + content + account info. */
  scopes?: readonly string[]
  /** `list_folder` page size. Clamped to 1…2000. Default 500. */
  pageSize?: number
  /** Whether listings and the change feed walk subfolders. Default `true`. */
  recursive?: boolean
  /** Hard ceiling for one upload. Default — and maximum — 150 MB. */
  uploadMaxBytes?: number
  /** Injected clock (tests). */
  now?: () => number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  account_id?: string
  error?: string
  error_description?: string
}

interface ListFolderResult {
  entries?: DropboxEntry[]
  cursor?: string
  has_more?: boolean
}

/** The adapter. Construct it with {@link dropboxDrive}. */
export class DropboxDrive implements DriveProvider {
  readonly name = 'dropbox'
  /**
   * The SSRF allowlist. `www.dropbox.com` is **not** on it: the consent URL is
   * handed to a browser and is never fetched by the framework, so allowing the
   * host would widen the guard for nothing.
   */
  readonly allowedHosts: readonly string[] = [API_HOST, CONTENT_HOST, NOTIFY_HOST]
  /** `list_folder` enumerates before it streams changes — see {@link START_CURSOR}. */
  readonly deltaIncludesExisting = true
  readonly authorization: DriveAuthorization

  private readonly pageSize: number
  private readonly recursive: boolean
  private readonly uploadMaxBytes: number
  private readonly scopes: readonly string[]
  private readonly now: () => number

  constructor(private readonly options: DropboxDriveOptions) {
    if (!options.clientId) throw new TypeError('dropboxDrive(): `clientId` is required.')
    this.pageSize = Math.min(Math.max(1, options.pageSize ?? 500), DROPBOX_MAX_PAGE_SIZE)
    this.recursive = options.recursive ?? true
    this.uploadMaxBytes = Math.min(options.uploadMaxBytes ?? DROPBOX_SINGLE_UPLOAD_MAX_BYTES, DROPBOX_SINGLE_UPLOAD_MAX_BYTES)
    this.scopes = options.scopes ?? DEFAULT_SCOPES
    this.now = options.now ?? Date.now
    this.authorization = this.buildAuthorization()
  }

  // ------------------------------------------------------------------ OAuth

  private buildAuthorization(): DriveAuthorization {
    return {
    /**
     * The consent URL. Pure — no I/O, and deliberately not fetched by anything
     * in this package.
     *
     * `token_access_type=offline` is what makes Dropbox return a refresh token
     * at all: without it the grant is an hour long and the connection dies
     * overnight. PKCE is always sent; Dropbox accepts it for confidential
     * clients too, and sending it costs nothing if the app also has a secret.
     */
    authorizeUrl: (input: DriveAuthorizeInput): string => {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('client_id', this.options.clientId)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', input.state)
      url.searchParams.set('token_access_type', 'offline')
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
        // The vendor's `error_description` is free text and is not forwarded;
        // the code is a fixed vocabulary and is.
        throw new DriveAuthorizationInvalidError(`Dropbox refused the code (${json.error ?? 'no access_token'}).`)
      }
      if (json.refresh_token === undefined) {
        // Without `token_access_type=offline` honoured, the connection would
        // work for an hour and then die with no way back. Better to refuse the
        // connect than to create one that is already broken.
        throw new DriveAuthorizationInvalidError(
          'Dropbox returned no refresh token; the authorization must request `token_access_type=offline`.',
        )
      }
      return this.tokensFrom(json)
    },

    /**
     * Dropbox does **not** rotate refresh tokens: the refresh response carries
     * only a new access token. The engine keeps the stored one when a provider
     * omits it, which is exactly right here — returning `refreshToken:
     * undefined` is honest, not lossy.
     */
    refresh: async (input: DriveRefreshInput): Promise<DriveTokens> => {
      const json = await this.token(input.fetch, {
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      })
      if (json.error === 'invalid_grant' || json.error === 'invalid_request') {
        // The grant is gone: revoked from the Dropbox account's connected-apps
        // page, or the app was uninstalled. Terminal, and the engine marks the
        // connection `invalid` instead of retrying from every queued job.
        throw new DriveCredentialsInvalidError('dropbox', `Dropbox rejected the refresh token (${json.error}).`)
      }
      if (json.error !== undefined || json.access_token === undefined) {
        // `invalid_client` and friends are OUR misconfiguration, not the
        // tenant's revocation. Failing generically keeps a deployment mistake
        // from logging every tenant out of their drive.
        throw new Error(`dropbox: token refresh failed (${json.error ?? 'no access_token'})`)
      }
      return this.tokensFrom(json)
    },

    revoke: async ({ tokens, fetch }: { tokens: DriveTokens; fetch: GuardedFetch }): Promise<void> => {
      const response = await fetch(`https://${API_HOST}/2/auth/token/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        maxBytes: 64 * 1024,
      })
      response.destroy()
    },

    account: async (session: DriveSession): Promise<DriveAccount> => {
      // `users/get_current_account` takes no argument, and Dropbox requires the
      // request to carry no Content-Type when that is the case.
      const json = await this.call<{ account_id?: string; email?: string; name?: { display_name?: string } }>(
        session,
        `https://${API_HOST}/2/users/get_current_account`,
        undefined,
      )
      return {
        ...(json.account_id !== undefined ? { id: json.account_id } : {}),
        ...(json.email !== undefined ? { email: json.email } : {}),
        ...(json.name?.display_name !== undefined ? { name: json.name.display_name } : {}),
      }
    },
    }
  }

  // ------------------------------------------------------------- operations

  async list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    const result = await this.listFolder(session, {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.cursor === undefined
        ? {
            path: dropboxPath(options.folderId ?? session.rootId),
            limit: Math.min(Math.max(1, options.limit ?? this.pageSize), DROPBOX_MAX_PAGE_SIZE),
            includeDeleted: false,
          }
        : {}),
    })
    return {
      items: (result.entries ?? []).filter((entry) => entry['.tag'] !== 'deleted').map(toDriveItem),
      // A cursor is only handed back while there is more of *this listing* to
      // read. Once `has_more` is false the same cursor becomes a change feed,
      // which is a different contract (`delta`) and must not leak into a
      // caller that thinks it is paginating a folder.
      ...(result.has_more === true && result.cursor !== undefined ? { cursor: result.cursor } : {}),
    }
  }

  async get(session: DriveSession, externalId: string): Promise<DriveItem | null> {
    const response = await this.rpc(session, `https://${API_HOST}/2/files/get_metadata`, {
      path: dropboxPath(externalId),
    })
    if (!response.ok) {
      // Dropbox answers 409 for every endpoint-specific refusal, including a
      // file that is simply gone. The contract says that one is `null`, not an
      // error — an import job for a file someone deleted mid-sync is not a
      // failure worth retrying.
      const body = await response.text()
      const error = toDropboxError(response.status, body, {
        provider: this.name,
        connectionId: session.connectionId,
        externalId,
      })
      if (error instanceof DriveItemNotFoundError) return null
      throw error
    }
    return toDriveItem((await response.json()) as DropboxEntry)
  }

  /**
   * Opens an item's bytes.
   *
   * Streamed, never buffered: the response body goes straight back to the
   * engine, which hands it to `@basaltkit/files`. The byte cap is the guarded
   * fetch's and is enforced mid-flight, so an oversized file costs the
   * abandoned prefix rather than its full size.
   */
  async download(session: DriveSession, item: DriveItem): Promise<DriveContent> {
    if (item.exportOnly === true) {
      throw new DriveUnsupportedError(this.name, `downloading the export-only item "${item.name}"`)
    }
    const response = await session.fetch(`https://${CONTENT_HOST}/2/files/download`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        // The argument travels in a header because the body is reserved for
        // the file itself. Non-ASCII is escaped; see `apiArg`.
        'Dropbox-API-Arg': apiArg({ path: dropboxPath(item.externalId) }),
        // The default `accept: application/json` would be a lie here, and some
        // proxies act on it.
        accept: '*/*',
      },
      ...(session.signal ? { signal: session.signal } : {}),
    })
    if (!response.ok) {
      await dropboxFailure(response, {
        provider: this.name,
        connectionId: session.connectionId,
        externalId: item.externalId,
      })
    }
    const meta = parseApiResult(response.headers['dropbox-api-result'])
    const size = meta?.size ?? item.size
    return {
      stream: response.body,
      // Dropbox states no media type, and the contract says the declared type
      // is untrusted anyway — `@basaltkit/files` sniffs the bytes.
      ...(item.contentType !== undefined ? { contentType: item.contentType } : {}),
      ...(size !== undefined ? { size } : {}),
    }
  }

  /**
   * Single-shot upload.
   *
   * The body is **streamed** onto the socket, not buffered: holding 150 MB per
   * concurrent upload in memory is how an import pipeline takes a process down.
   * The cap is enforced on the bytes that actually flow, so a source that lies
   * about its size is caught mid-stream rather than trusted.
   *
   * Files over the cap are refused up front with `DRIVE_CONTENT_TOO_LARGE`;
   * `files/upload_session/*` is a documented limitation, not a silent one.
   */
  async upload(session: DriveSession, input: DriveUploadInput): Promise<DriveItem> {
    if (input.size !== undefined && input.size > this.uploadMaxBytes) {
      input.content.destroy()
      throw new DriveContentTooLargeError(this.uploadMaxBytes)
    }
    const folder = dropboxPath(input.folderId ?? session.rootId)
    const path = `${folder}/${sanitizeName(input.name)}`
    const response = await session.fetch(`https://${CONTENT_HOST}/2/files/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'Dropbox-API-Arg': apiArg({ path, mode: 'add', autorename: true, mute: false, strict_conflict: false }),
        'content-type': 'application/octet-stream',
      },
      body: capStream(input.content, this.uploadMaxBytes),
      ...(session.signal ? { signal: session.signal } : {}),
    })
    if (!response.ok) {
      await dropboxFailure(response, { provider: this.name, connectionId: session.connectionId })
    }
    return toDriveItem((await response.json()) as DropboxEntry)
  }

  /** See {@link START_CURSOR}: the feed starts at the folder, not at "now". */
  async startDelta(session: DriveSession, options: { folderId?: string | undefined }): Promise<string> {
    return `${START_CURSOR}${dropboxPath(options.folderId ?? session.rootId)}`
  }

  async delta(session: DriveSession, cursor: string): Promise<DriveDelta> {
    const result = cursor.startsWith(START_CURSOR)
      ? await this.listFolder(session, {
          path: cursor.slice(START_CURSOR.length),
          limit: this.pageSize,
          includeDeleted: true,
        })
      : await this.listFolder(session, { cursor })
    if (result.cursor === undefined) {
      // Without a cursor there is nothing to resume from, and pretending
      // otherwise would silently restart the feed on every run.
      throw new Error('dropbox: list_folder returned no cursor')
    }
    return {
      changes: (result.entries ?? []).map(toDriveChange),
      cursor: result.cursor,
      hasMore: result.has_more === true,
    }
  }

  /**
   * Dropbox has **no per-connection subscription to register**, so `watch` and
   * `unwatch` are absent rather than throwing: the engine probes for the method
   * and reports `DRIVE_UNSUPPORTED`, which is the honest answer.
   *
   * The webhook URI is configured once per app in the App Console and fires for
   * every user who has authorized it. That is why
   * {@link DriveNotificationResult.accountIds} exists.
   */
  verifyNotification(input: DriveNotificationInput): DriveNotificationResult {
    if (input.method.toUpperCase() === 'GET') {
      const challenge = input.query['challenge']
      if (challenge === undefined || challenge === '') {
        throw new DriveNotificationInvalidError('the handshake carried no challenge.')
      }
      // Bounded because it is reflected verbatim. Dropbox's own challenge is a
      // short random token; anything longer is someone else's idea.
      if (challenge.length > 256) throw new DriveNotificationInvalidError('the challenge is too long.')
      return { challenge, changed: false }
    }

    const secret = this.options.webhookSecret ?? this.options.clientSecret
    if (secret === undefined || secret === '') {
      // Fail closed. An adapter with no signing key cannot tell a real
      // notification from a forged one, and accepting either would hand an
      // unauthenticated caller a sync trigger.
      throw new DriveNotificationInvalidError('no webhook signing secret is configured.')
    }
    if (
      !verifyHmacSignature({
        // The RAW bytes. A re-serialised body is a different message.
        body: input.body,
        signature: input.headers['x-dropbox-signature'],
        secret,
        algorithm: 'sha256',
        encoding: 'hex',
      })
    ) {
      throw new DriveNotificationInvalidError('the signature did not verify.')
    }

    let accounts: unknown
    try {
      accounts = (JSON.parse(input.body.toString('utf8')) as { list_folder?: { accounts?: unknown } })?.list_folder
        ?.accounts
    } catch {
      throw new DriveNotificationInvalidError('the notification body is not JSON.')
    }
    const accountIds = Array.isArray(accounts) ? accounts.filter((id): id is string => typeof id === 'string') : []
    // Content-free by construction: the body names accounts, never files. The
    // engine turns that into "go and ask the provider, with our own
    // credentials, for our own tenant".
    return { accountIds, changed: accountIds.length > 0 }
  }

  /** Dropbox puts its rate-limit hint in the body when it omits `Retry-After`. */
  retryAfterFromBody(body: string): number | undefined {
    return retryAfterFromBody(body)
  }

  // ----------------------------------------------------------------- guts

  private async listFolder(
    session: DriveSession,
    input: { cursor?: string; path?: string; limit?: number; includeDeleted?: boolean },
  ): Promise<ListFolderResult> {
    const url =
      input.cursor !== undefined
        ? `https://${API_HOST}/2/files/list_folder/continue`
        : `https://${API_HOST}/2/files/list_folder`
    const arg =
      input.cursor !== undefined
        ? { cursor: input.cursor }
        : {
            path: input.path ?? '',
            recursive: this.recursive,
            limit: input.limit ?? this.pageSize,
            include_deleted: input.includeDeleted ?? false,
            include_media_info: false,
            include_has_explicit_shared_members: false,
            include_mounted_folders: true,
            include_non_downloadable_files: true,
          }
    return this.call<ListFolderResult>(session, url, arg)
  }

  /** One RPC call, mapped on failure. */
  private async call<T>(session: DriveSession, url: string, arg: unknown): Promise<T> {
    const response = await this.rpc(session, url, arg)
    if (!response.ok) {
      await dropboxFailure(response, { provider: this.name, connectionId: session.connectionId })
    }
    return (await response.json()) as T
  }

  private async rpc(session: DriveSession, url: string, arg: unknown): Promise<GuardedResponse> {
    return session.fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        // Dropbox rejects a Content-Type on an argument-less RPC call.
        ...(arg === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(arg === undefined ? {} : { body: JSON.stringify(arg) }),
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
   * call that carries the app secret.
   */
  private async token(fetch: GuardedFetch, fields: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams({ ...fields, client_id: this.options.clientId })
    if (this.options.clientSecret !== undefined) form.set('client_secret', this.options.clientSecret)
    const response = await fetch(`https://${API_HOST}/oauth2/token`, {
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
 * Builds the Dropbox adapter.
 *
 * ```ts
 * drivesPlugin({
 *   providers: [dropboxDrive({ clientId: env.DROPBOX_KEY, clientSecret: env.DROPBOX_SECRET })],
 *   keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
 *   secret: env.APP_SECRET,
 * })
 * ```
 */
export function dropboxDrive(options: DropboxDriveOptions): DropboxDrive {
  return new DropboxDrive(options)
}

/** `Dropbox-API-Result` carries the file's metadata alongside the bytes. */
function parseApiResult(header: string | undefined): DropboxEntry | undefined {
  if (header === undefined) return undefined
  try {
    return JSON.parse(header) as DropboxEntry
  } catch {
    return undefined
  }
}

/**
 * A filename, made safe for a Dropbox path.
 *
 * Path separators and traversal are removed rather than escaped: a name is a
 * name, and `../../` in one is either a bug or an attempt to write outside the
 * connection's root.
 */
function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').trim()
  return cleaned === '' ? 'file' : cleaned.slice(0, 255)
}
