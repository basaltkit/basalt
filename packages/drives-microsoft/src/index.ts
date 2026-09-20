import {
  DriveAuthorizationInvalidError,
  DriveContentTooLargeError,
  DriveCredentialsInvalidError,
  DriveItemNotFoundError,
  DriveNotificationInvalidError,
  DriveProviderError,
  DriveUnsupportedError,
  capStream,
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
  type DriveWatch,
  type DriveWatchInput,
  type GuardedFetch,
  type GuardedResponse,
} from '@basaltkit/drives'
import {
  isDeltaStart,
  openDeltaStart,
  openLinkCursor,
  sealDeltaCursor,
  sealDeltaStart,
  sealListCursor,
} from './cursor.js'
import { graphFailure, toGraphError } from './errors.js'
import { sanitizeName, toDriveChange, toDriveItem, type GraphItem, type GraphPage } from './metadata.js'
import {
  driveBase,
  invalidRootHandle,
  isSafeId,
  itemInDrive,
  itemResource,
  parseMicrosoftRoot,
  type MicrosoftRoot,
} from './roots.js'

export { errorCode, graphFailure, toGraphError, type GraphFailureContext } from './errors.js'
export {
  sanitizeName,
  toChecksum,
  toDriveChange,
  toDriveItem,
  toPath,
  type GraphHashes,
  type GraphItem,
  type GraphPage,
} from './metadata.js'
export {
  driveBase,
  invalidRootHandle,
  isSafeId,
  itemInDrive,
  itemResource,
  microsoftRoot,
  parseMicrosoftRoot,
  type MicrosoftRoot,
} from './roots.js'
export { DELTA_START_PREFIX } from './cursor.js'

/**
 * The Microsoft OneDrive / SharePoint adapter, over Microsoft Graph.
 *
 * It is the second real implementation of the `@basaltkit/drives` contract, and
 * it was written to land on the **other side** of nearly every difference the
 * Dropbox adapter uncovered: Graph rotates refresh tokens, reports deletions by
 * id, authenticates notifications with a secret we chose, and hands back a
 * delta feed that enumerates before it streams.
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
 * | Capability | Microsoft Graph |
 * |---|---|
 * | consent | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` (browser only; never fetched) |
 * | token, refresh | `POST {authority}/oauth2/v2.0/token`, `offline_access` + PKCE |
 * | revoke | **does not exist** — see {@link MicrosoftDrive.authorization} |
 * | account | `GET /v1.0/me` |
 * | list | `GET {resource}/children`, paging on `@odata.nextLink` |
 * | metadata | `GET {resource}?$select=…` |
 * | download | `@microsoft.graph.downloadUrl`, fetched **unauthenticated** |
 * | upload | `PUT {resource}:/{name}:/content` (simple upload, ≤ 4 MB) |
 * | change feed | `GET {resource}/delta`, finishing on `@odata.deltaLink` |
 * | notifications | `POST /v1.0/subscriptions` with a `clientState` we generated |
 *
 * ## Known limitations
 *
 * - **Uploads over 4 MB are not supported.** Graph's simple `PUT …/content`
 *   ceiling is 4 MB — the lowest of the three vendors — and anything larger
 *   needs `createUploadSession`, a three-call resumable protocol with its own
 *   chunking and retry story. Larger files are refused up front with
 *   `DRIVE_CONTENT_TOO_LARGE` rather than after the bytes have been sent.
 * - **There is no revocation.** Graph has no per-application revoke endpoint;
 *   the user withdraws consent in their own account portal (or an administrator
 *   does, in Entra ID). `revoke` is optional in the contract, so it is omitted
 *   and `disconnect` honestly reports `revoked: false`.
 * - **A subscription covers the whole drive, not a folder.** Graph only accepts
 *   `/drives/{id}/root` as a `driveItem` subscription resource, so a connection
 *   scoped to a subfolder still receives notifications for the entire drive. It
 *   costs a wasted sync, never a wrong one — the sync itself is still confined
 *   to the connection's root.
 * - **Subscriptions expire** (under 30 days for a drive). Renewal is the app's
 *   job; {@link DriveWatch.expiresAt} is surfaced for exactly that, and the
 *   README shows the `defineReconciler` that does it.
 * - **Export-only items are reported, not exported.** A OneNote notebook (a
 *   `package` facet) surfaces with `exportOnly: true`; Graph has no `export`
 *   for it, so `download` refuses.
 * - **Cross-drive shared items are out of scope.** An item that lives in
 *   someone else's drive and appears through "Shared with me" is addressed by
 *   its owning drive, and a connection is deliberately confined to one drive.
 */

const LOGIN_HOST = 'login.microsoftonline.com'
const GRAPH_HOST = 'graph.microsoft.com'
const GRAPH_BASE = `https://${GRAPH_HOST}/v1.0`

/**
 * Hosts a `@microsoft.graph.downloadUrl` (or a `/content` redirect) can point
 * at, as **`.suffix` entries — never bare parents**.
 *
 * `.sharepoint.com` matches `contoso-my.sharepoint.com` and not
 * `sharepoint.com`, and critically not `evilsharepoint.com`, which a naive
 * `endsWith` would wave through. The guard re-validates every hop anyway: the
 * allowlist is what bounds *where*, the SSRF guard is what bounds *what address
 * that host resolves to*.
 *
 * - `.files.1drv.com` — personal OneDrive content hosts.
 * - `.sharepoint.com` — OneDrive for Business and SharePoint libraries.
 * - `.svc.ms` — the CDN Graph redirects `/content` through for some tenants.
 *
 * An operator who knows their tenant can narrow this to one exact host with
 * {@link MicrosoftDriveOptions.downloadHosts}, which is strictly better and
 * takes one line.
 */
export const MICROSOFT_DOWNLOAD_HOSTS: readonly string[] = ['.files.1drv.com', '.sharepoint.com', '.svc.ms']

/** Graph's ceiling for a simple `PUT …/content`. The lowest of the three vendors. */
export const GRAPH_SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024

/**
 * The longest a `driveItem` subscription may live: 42 300 minutes, a little
 * under 30 days. Graph refuses anything longer outright.
 */
export const GRAPH_MAX_SUBSCRIPTION_MS = 42_300 * 60_000

/** `$top` ceiling Graph honours for `/children` and `/delta`. */
export const GRAPH_MAX_PAGE_SIZE = 999

/**
 * Fields read from a `driveItem`.
 *
 * Explicit rather than "everything", for two reasons. It keeps a listing from
 * dragging back sharing state, user names and email addresses an app never
 * asked to store — and, more importantly, **it excludes
 * `@microsoft.graph.downloadUrl`**, so the pre-signed credential cannot reach a
 * listing, a sink, `DriveItem.raw` or a log. `download` asks for it separately,
 * uses it immediately and never persists it.
 */
const ITEM_SELECT =
  'id,name,size,eTag,cTag,createdDateTime,lastModifiedDateTime,webUrl,folder,file,package,remoteItem,parentReference'

/** What `download` asks for, and nothing more. */
const DOWNLOAD_SELECT = 'id,name,size,file,package,remoteItem,@microsoft.graph.downloadUrl'

/**
 * The least that works for a read-only personal OneDrive connection.
 *
 * `offline_access` is what makes Microsoft return a refresh token at all —
 * without it the grant lasts about an hour and the connection dies before
 * anybody notices. SharePoint needs more (`Files.Read.All`, `Sites.Read.All`);
 * see the README.
 */
const DEFAULT_SCOPES = ['offline_access', 'User.Read', 'Files.Read'] as const

/** `common`, `organizations`, `consumers`, a tenant GUID or a verified domain. */
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface MicrosoftDriveOptions {
  /** Application (client) id from the Entra ID app registration. */
  clientId: string
  /**
   * Client secret.
   *
   * Optional: a public client (a SPA or a desktop app registration) uses PKCE
   * alone. A web app registration has a secret and must send it. Unlike
   * Dropbox, it is **not** also a webhook signing key — Graph does not sign
   * notifications at all; the `clientState` we generate per subscription is the
   * authentication.
   */
  clientSecret?: string
  /**
   * Which Entra ID authority to use.
   *
   * - `common` (default) — any Microsoft account, personal or work/school.
   * - `organizations` — work/school accounts only.
   * - `consumers` — personal Microsoft accounts only.
   * - a tenant GUID or verified domain (`contoso.onmicrosoft.com`) — that one
   *   tenant, which is what a single-tenant app registration requires.
   *
   * See the README for what changes when the app registration is multi-tenant.
   */
  tenant?: string
  /** Scopes to request. Default: `offline_access User.Read Files.Read`. */
  scopes?: readonly string[]
  /**
   * Scopes sent on a **refresh**.
   *
   * Defaults to whatever the connection stored at consent time, falling back to
   * {@link scopes}. Microsoft wants the refresh request's scope to be a subset
   * of the original grant's; asking for more turns a routine refresh into an
   * `invalid_grant`.
   */
  refreshScopes?: readonly string[]
  /** `prompt` on the consent URL (`select_account`, `consent`, `login`). Omitted by default. */
  prompt?: string
  /** Hosts a download may be redirected to. Defaults to {@link MICROSOFT_DOWNLOAD_HOSTS}. */
  downloadHosts?: readonly string[]
  /** `$top` for listings and the change feed. Clamped to 1…999. Default 200. */
  pageSize?: number
  /** Hard ceiling for one upload. Default — and maximum — 4 MB. */
  uploadMaxBytes?: number
  /** Subscription lifetime to request. Clamped to Graph's maximum (~30 days). */
  subscriptionTtlMs?: number
  /** Change types to subscribe to. Default `['updated']`, which covers create, edit and delete. */
  changeTypes?: readonly string[]
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
  error_codes?: number[]
}

interface GraphSubscription {
  id?: string
  resource?: string
  expirationDateTime?: string
  clientState?: string
}

/** One entry of a Graph change notification delivery. */
interface GraphNotification {
  subscriptionId?: unknown
  clientState?: unknown
  changeType?: unknown
  resource?: unknown
  lifecycleEvent?: unknown
}

/** The adapter. Construct it with {@link microsoftDrive}. */
export class MicrosoftDrive implements DriveProvider {
  readonly name = 'microsoft'
  /**
   * The SSRF allowlist.
   *
   * `login.microsoftonline.com` is here because the **token** endpoint is
   * fetched (the consent URL is handed to a browser and never opened by the
   * framework — there is no separate host for it to add). `graph.microsoft.com`
   * is the API. Everything after that is a content host, and every entry is a
   * `.suffix`: see {@link MICROSOFT_DOWNLOAD_HOSTS}.
   */
  readonly allowedHosts: readonly string[]
  /**
   * `/delta` with no token enumerates the drive first and only then hands over
   * a `deltaLink`, so the change feed *is* the backfill. Declaring this
   * honestly is what stops the engine from running a redundant full listing
   * pass before the first delta run — and, on Google, declaring it wrongly is
   * what would make a first sync import nothing at all.
   */
  readonly deltaIncludesExisting = true
  readonly authorization: DriveAuthorization

  private readonly tenant: string
  private readonly authority: string
  private readonly scopes: readonly string[]
  private readonly refreshScopes: readonly string[] | undefined
  private readonly pageSize: number
  private readonly uploadMaxBytes: number
  private readonly subscriptionTtl: number
  private readonly changeTypes: readonly string[]
  private readonly now: () => number

  constructor(private readonly options: MicrosoftDriveOptions) {
    if (!options.clientId) throw new TypeError('microsoftDrive(): `clientId` is required.')
    this.tenant = options.tenant ?? 'common'
    if (!SAFE_TENANT.test(this.tenant)) {
      // The tenant goes straight into the authority URL's path. Validated at
      // configuration time so a typo is a startup failure rather than a
      // request-time surprise.
      throw new TypeError('microsoftDrive(): `tenant` must be "common", "organizations", "consumers", a tenant id or a domain.')
    }
    this.authority = `https://${LOGIN_HOST}/${this.tenant}/oauth2/v2.0`
    this.scopes = options.scopes ?? DEFAULT_SCOPES
    this.refreshScopes = options.refreshScopes
    this.pageSize = Math.min(Math.max(1, options.pageSize ?? 200), GRAPH_MAX_PAGE_SIZE)
    this.uploadMaxBytes = Math.min(options.uploadMaxBytes ?? GRAPH_SIMPLE_UPLOAD_MAX_BYTES, GRAPH_SIMPLE_UPLOAD_MAX_BYTES)
    this.subscriptionTtl = Math.min(options.subscriptionTtlMs ?? GRAPH_MAX_SUBSCRIPTION_MS, GRAPH_MAX_SUBSCRIPTION_MS)
    this.changeTypes = options.changeTypes ?? ['updated']
    this.now = options.now ?? Date.now
    this.allowedHosts = [LOGIN_HOST, GRAPH_HOST, ...(options.downloadHosts ?? MICROSOFT_DOWNLOAD_HOSTS)]
    this.authorization = this.buildAuthorization()
  }

  // ------------------------------------------------------------------ OAuth

  private buildAuthorization(): DriveAuthorization {
    return {
      /**
       * The consent URL. Pure — no I/O, and deliberately not fetched by
       * anything in this package.
       *
       * `offline_access` is the Microsoft equivalent of Dropbox's
       * `token_access_type=offline`: without it there is no refresh token and
       * the connection is already broken when it is created. PKCE is always
       * sent; Entra ID accepts it for confidential clients too and it costs
       * nothing when the app also has a secret.
       */
      authorizeUrl: (input: DriveAuthorizeInput): string => {
        const url = new URL(`${this.authority}/authorize`)
        url.searchParams.set('client_id', this.options.clientId)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('redirect_uri', input.redirectUri)
        url.searchParams.set('response_mode', 'query')
        url.searchParams.set('state', input.state)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        const scopes = this.withOfflineAccess(input.scopes ?? this.scopes)
        url.searchParams.set('scope', scopes.join(' '))
        if (this.options.prompt !== undefined) url.searchParams.set('prompt', this.options.prompt)
        return url.toString()
      },

      exchange: async (input: DriveExchangeInput): Promise<DriveTokens> => {
        // **No `scope` on the code exchange.** The authorization code already
        // names what the user consented to, and Entra ID reports it back in
        // `scope` — which the engine stores on the connection and hands to the
        // refresh. Re-asserting a scope list here could only ever disagree with
        // the consent that actually happened: `DriveExchangeInput` does not
        // carry the scopes the flow was started with, so the adapter would be
        // asserting its own defaults over a caller's `startAuthorization({
        // scopes })`.
        const json = await this.token(input.fetch, undefined, {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        })
        if (json.error !== undefined || json.access_token === undefined) {
          // `error_description` is free text (and carries the AADSTS trace id
          // and correlation ids) and is not forwarded; the code is a fixed
          // vocabulary and is.
          throw new DriveAuthorizationInvalidError(`Microsoft refused the code (${json.error ?? 'no access_token'}).`)
        }
        if (json.refresh_token === undefined) {
          // Without `offline_access` honoured, the connection works for about
          // an hour and then there is no way back. Better to refuse the connect
          // than to create one that is already broken.
          throw new DriveAuthorizationInvalidError(
            'Microsoft returned no refresh token; the authorization must request the `offline_access` scope.',
          )
        }
        return this.tokensFrom(json)
      },

      /**
       * Refresh — and this is the one that makes Microsoft different.
       *
       * **Every refresh rotates the refresh token**: the response carries a new
       * one and the old one is dead the instant it is issued. The engine's
       * compare-and-set on `revision` and its lost-rotation-race handling
       * (RFC 0002 §4.4) exist for precisely this, so nothing here tries to work
       * around it: the adapter reports what the provider said and lets the
       * engine persist it.
       *
       * The consequence for error mapping is subtle and load-bearing. A second
       * worker that refreshed a moment ago has already retired the token we
       * just tried to spend, and Entra ID answers that with the *same*
       * `invalid_grant` it uses for a revoked consent. This method reports it
       * as terminal, which is correct; the engine re-reads the row before
       * condemning the connection and adopts the winner's credentials when
       * somebody stored usable ones. Deciding here would mean deciding without
       * the store.
       */
      refresh: async (input: DriveRefreshInput): Promise<DriveTokens> => {
        // The scopes the connection was actually granted, when the engine knows
        // them. Microsoft wants the refresh scope to be a subset of the
        // original grant, so an adapter default would quietly downgrade a
        // connection that consented to SharePoint scopes.
        const scopes = this.refreshScopes ?? input.scopes ?? this.scopes
        const json = await this.token(input.fetch, scopes, {
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
        })
        if (json.error === 'invalid_grant' || json.error === 'interaction_required' || json.error === 'consent_required') {
          // The grant is gone: consent withdrawn in the account portal, the
          // user removed from the tenant, a conditional-access policy that now
          // demands interaction, or a refresh token that aged out. Terminal,
          // and the engine marks the connection `invalid` instead of retrying
          // from every queued job.
          throw new DriveCredentialsInvalidError('microsoft', `Microsoft rejected the refresh token (${json.error}).`)
        }
        if (json.error !== undefined || json.access_token === undefined) {
          // `invalid_client`, `unauthorized_client` and friends are OUR
          // misconfiguration, not the tenant's revocation. Failing generically
          // keeps one bad environment variable from logging every tenant out of
          // their drive.
          throw new Error(`microsoft: token refresh failed (${json.error ?? 'no access_token'})`)
        }
        return this.tokensFrom(json)
      },

      /**
       * **`revoke` is deliberately absent.**
       *
       * Microsoft Graph has no per-application revocation endpoint. There is
       * `POST /me/revokeSignInSessions`, but that invalidates the user's
       * sessions and refresh tokens for *every* application, which is not what
       * "disconnect this drive" means and is not ours to do. Consent is
       * withdrawn by the user at `myaccount.microsoft.com`, or by an
       * administrator in Entra ID.
       *
       * `revoke?` is optional in the contract, so omitting it is the honest
       * answer: `disconnect` deletes the row and its sealed credentials, and
       * reports `revoked: false`. An operator reading that should understand
       * that the grant may still be live at Microsoft — which is a smaller
       * promise than "disconnect" makes on Dropbox or Google, and the README
       * says so plainly.
       */

      account: async (session: DriveSession): Promise<DriveAccount> => {
        const json = await this.call<{ id?: string; mail?: string; userPrincipalName?: string; displayName?: string }>(
          session,
          `${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`,
        )
        const email = json.mail ?? json.userPrincipalName
        return {
          ...(json.id !== undefined ? { id: json.id } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(json.displayName !== undefined ? { name: json.displayName } : {}),
        }
      },
    }
  }

  // ------------------------------------------------------------- operations

  async list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    // A cursor is a whole `@odata.nextLink`, kept opaque. See `cursor.ts` for
    // why that is a wrapper rather than the raw URL, and why the guard
    // re-validates it even though we produced it.
    const url =
      options.cursor !== undefined
        ? openLinkCursor(options.cursor, 'list', GRAPH_HOST, this.name)
        : `${GRAPH_BASE}${itemResource(this.targetOf(session, options.folderId))}/children` +
          `?$top=${Math.min(Math.max(1, options.limit ?? this.pageSize), GRAPH_MAX_PAGE_SIZE)}` +
          `&$select=${ITEM_SELECT}`
    const page = await this.call<GraphPage>(session, url)
    const next = page['@odata.nextLink']
    return {
      items: (page.value ?? []).map(toDriveItem),
      ...(next !== undefined ? { cursor: sealListCursor(next) } : {}),
    }
  }

  async get(session: DriveSession, externalId: string): Promise<DriveItem | null> {
    const root = this.rootOf(session)
    const response = await this.request(
      session,
      `${GRAPH_BASE}${itemInDrive(root, externalId, this.name)}?$select=${ITEM_SELECT}`,
    )
    if (!response.ok) {
      const error = toGraphError(response.status, await this.readText(response), {
        provider: this.name,
        connectionId: session.connectionId,
        externalId,
      })
      // The contract says a missing item is `null`, not an error: an import job
      // for a file somebody deleted mid-sync is not a failure worth retrying.
      if (error instanceof DriveItemNotFoundError) return null
      throw error
    }
    return toDriveItem(await response.json<GraphItem>())
  }

  /**
   * Opens an item's bytes.
   *
   * The interesting part is what is **not** done. Graph offers two ways in:
   *
   * - `GET {item}/content`, which answers `302` to a CDN host, and
   * - `@microsoft.graph.downloadUrl`, a short-lived pre-signed URL.
   *
   * This adapter asks for the pre-signed URL and fetches it with **no
   * `Authorization` header**, so the Graph bearer token is never presented to a
   * host that does not need it. The `/content` redirect is only a fallback, for
   * the rare item Graph declines to pre-sign.
   *
   * The URL itself is treated as a credential throughout: it is fetched
   * immediately, never stored in {@link DriveItem.raw}, never logged, and never
   * placed in an error's `details` — which is why a failure from the content
   * host is reported with a fixed summary and the body is destroyed unread.
   */
  async download(session: DriveSession, item: DriveItem): Promise<DriveContent> {
    if (item.exportOnly === true) {
      throw new DriveUnsupportedError(this.name, `downloading the export-only item "${item.name}"`)
    }
    const root = this.rootOf(session)
    const meta = await this.call<GraphItem>(
      session,
      `${GRAPH_BASE}${itemInDrive(root, item.externalId, this.name)}?$select=${DOWNLOAD_SELECT}`,
      {},
      { externalId: item.externalId },
    )
    if (meta.package !== undefined || meta.remoteItem !== undefined) {
      // Re-checked against fresh metadata, not just the caller's item: a
      // shortcut or a notebook that reached `download` with the flag missing
      // would otherwise 404 on every retry for ever.
      throw new DriveUnsupportedError(this.name, `downloading the export-only item "${item.name ?? item.externalId}"`)
    }

    const presigned = meta['@microsoft.graph.downloadUrl']
    const response =
      presigned !== undefined
        ? await session.fetch(presigned, {
            // No `authorization`. The URL carries its own short-lived token,
            // and sending a Graph bearer token to a CDN would hand a wider
            // credential to a host that never needed one.
            headers: { accept: '*/*' },
            ...(session.signal ? { signal: session.signal } : {}),
          })
        : await session.fetch(`${GRAPH_BASE}${itemInDrive(root, item.externalId, this.name)}/content`, {
            headers: { authorization: `Bearer ${session.accessToken}`, accept: '*/*' },
            ...(session.signal ? { signal: session.signal } : {}),
          })

    if (!response.ok) {
      response.destroy()
      // Nothing from this body is forwarded: on the pre-signed path the host is
      // a CDN whose error pages quote the request URL, and that URL is a bearer
      // credential. A 403/404 here is usually an expired pre-signed URL, so it
      // is marked retryable — the retry re-reads the metadata and gets a fresh
      // one, which is the self-healing behaviour.
      const retryable = response.status === 403 || response.status === 404 || response.status >= 500
      throw new DriveProviderError(this.name, 'downloadRejected', response.status, retryable)
    }

    const size = meta.size ?? item.size
    const declared = response.headers['content-type'] ?? meta.file?.mimeType ?? item.contentType
    return {
      stream: response.body,
      // Still only a hint by contract — `@basaltkit/files` sniffs the bytes.
      ...(declared !== undefined ? { contentType: declared } : {}),
      ...(size !== undefined ? { size } : {}),
    }
  }

  /**
   * Simple upload.
   *
   * The body is **streamed** onto the socket, never buffered. The 4 MB ceiling
   * is Graph's own for `PUT …/content` and the lowest of the three vendors;
   * anything larger needs `createUploadSession`, which is deliberately out of
   * scope for now, so larger files are refused up front rather than after the
   * bytes have been sent. A source that lies about its size is caught
   * mid-stream by the cap instead of being trusted.
   */
  async upload(session: DriveSession, input: DriveUploadInput): Promise<DriveItem> {
    if (input.size !== undefined && input.size > this.uploadMaxBytes) {
      input.content.destroy()
      throw new DriveContentTooLargeError(this.uploadMaxBytes)
    }
    const target = this.targetOf(session, input.folderId)
    const name = encodeURIComponent(sanitizeName(input.name))
    const response = await session.fetch(
      `${GRAPH_BASE}${itemResource(target)}:/${name}:/content?%40microsoft.graph.conflictBehavior=rename`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'content-type': input.contentType,
        },
        body: capStream(input.content, this.uploadMaxBytes),
        ...(session.signal ? { signal: session.signal } : {}),
      },
    )
    if (!response.ok) {
      await graphFailure(response, { provider: this.name, connectionId: session.connectionId })
    }
    return toDriveItem(await response.json<GraphItem>())
  }

  /**
   * Establishes the delta cursor.
   *
   * Graph has no way to hand back a cursor positioned at the *beginning* of a
   * drive without also delivering the first page: `GET {resource}/delta` with
   * no token returns the enumeration **and** the link to continue it. So this
   * returns a synthetic marker, and the first {@link delta} call turns it into
   * the real request. The cursor is opaque to the engine by contract, which is
   * what makes that legal rather than a hack — and it is why this adapter can
   * declare {@link deltaIncludesExisting} `true` honestly.
   */
  async startDelta(session: DriveSession, options: { folderId?: string | undefined }): Promise<string> {
    return sealDeltaStart(itemResource(this.targetOf(session, options.folderId)))
  }

  async delta(session: DriveSession, cursor: string): Promise<DriveDelta> {
    const url = isDeltaStart(cursor)
      ? `${GRAPH_BASE}${openDeltaStart(cursor, this.name)}/delta?$top=${this.pageSize}`
      : openLinkCursor(cursor, 'delta', GRAPH_HOST, this.name)
    const page = await this.call<GraphPage>(session, url, {}, { delta: true })
    const next = page['@odata.nextLink']
    const final = page['@odata.deltaLink']
    if (next === undefined && final === undefined) {
      // Without a link there is nothing to resume from, and pretending
      // otherwise would silently restart the feed on every run.
      throw new Error('microsoft: /delta returned neither an @odata.nextLink nor an @odata.deltaLink')
    }
    return {
      changes: (page.value ?? []).map(toDriveChange),
      cursor: next !== undefined ? sealDeltaCursor(next) : sealDeltaCursor(final as string),
      hasMore: next !== undefined,
    }
  }

  /**
   * Registers a Graph change subscription.
   *
   * `clientState` is the secret the **engine** generated, and it is the whole
   * of the authentication: Graph does not sign notifications. It comes back on
   * every delivery and {@link verifyNotification} compares it in constant time.
   *
   * Two things worth knowing, both surfaced rather than hidden:
   *
   * - Graph **calls the notification URL synchronously** while creating the
   *   subscription, with a `validationToken` it expects echoed as `text/plain`
   *   within seconds. A `watch()` that fails with `400
   *   subscriptionValidationFailed` means the route is not reachable from the
   *   internet, not that the code is wrong.
   * - The subscription **expires** — under 30 days for a drive, less for other
   *   resources — and Graph never renews it. {@link DriveWatch.expiresAt} is
   *   surfaced so the app can renew it from a reconciler; see the README.
   */
  async watch(session: DriveSession, input: DriveWatchInput): Promise<DriveWatch> {
    const root = this.rootOf(session)
    const ttl = Math.min(input.ttlMs ?? this.subscriptionTtl, GRAPH_MAX_SUBSCRIPTION_MS)
    // Graph only accepts a drive's ROOT as a driveItem subscription resource, so
    // a connection scoped to a subfolder is still watched at the drive level.
    // It costs a wasted sync, never a wrong one: the sync stays confined to the
    // connection's own root.
    const resource = `${driveBase(root)}/root`
    const json = await this.call<GraphSubscription>(session, `${GRAPH_BASE}/subscriptions`, {
      method: 'POST',
      json: {
        changeType: this.changeTypes.join(','),
        notificationUrl: input.notificationUrl,
        resource,
        expirationDateTime: new Date(this.now() + ttl).toISOString(),
        clientState: input.secret,
      },
    })
    if (!isSafeId(json.id)) {
      throw new DriveProviderError(this.name, 'subscriptionIdMissing', 502, false)
    }
    const expiresAt = json.expirationDateTime !== undefined ? Date.parse(json.expirationDateTime) : Number.NaN
    return {
      id: json.id,
      expiresAt: Number.isNaN(expiresAt) ? this.now() + ttl : expiresAt,
      raw: { resource: json.resource ?? resource },
    }
  }

  async unwatch(session: DriveSession, watch: DriveWatch): Promise<void> {
    if (!isSafeId(watch.id)) return
    const response = await this.request(session, `${GRAPH_BASE}/subscriptions/${watch.id}`, { method: 'DELETE' })
    // A subscription that has already expired answers 404. Deleting something
    // that is already gone is a success, not a failure worth propagating into
    // `disconnect`.
    if (!response.ok && response.status !== 404) {
      await graphFailure(response, { provider: this.name, connectionId: session.connectionId })
    } else {
      response.destroy()
    }
  }

  /**
   * Verifies an inbound notification. **Pure and synchronous** — no session, no
   * network, so hammering the webhook route cannot be amplified into Graph
   * traffic.
   *
   * Two shapes arrive here:
   *
   * 1. **The validation handshake.** Graph POSTs `?validationToken=…` and
   *    expects it echoed verbatim as `text/plain` within seconds — during
   *    `POST /subscriptions`, so *before* any subscription exists to look up.
   *    Returning it as {@link DriveNotificationResult.challenge} lets the
   *    shared neutral route answer it; this adapter adds no route of its own.
   * 2. **A change notification**, a JSON envelope of one or more entries, each
   *    carrying the `clientState` we chose. There is no signature anywhere in
   *    Graph's webhook design: `clientState` **is** the authentication, so an
   *    entry without one is rejected rather than treated as anonymous.
   *
   * One delivery may batch entries for several subscriptions that share a
   * notification URL — two connections of the same tenant, or two tenants
   * behind one route. Reporting only the first would sync one and leave the
   * rest stale, so a batch is reported as {@link DriveNotificationResult.secrets}.
   */
  verifyNotification(input: DriveNotificationInput): DriveNotificationResult {
    const validationToken = input.query['validationToken']
    if (validationToken !== undefined && validationToken !== '') {
      // Bounded because it is reflected verbatim onto the app's own origin.
      // Graph's own token is a short opaque string; anything longer is somebody
      // else's idea.
      if (validationToken.length > 1024) throw new DriveNotificationInvalidError('the validation token is too long.')
      return { challenge: validationToken, changed: false }
    }

    let entries: GraphNotification[]
    try {
      const parsed = JSON.parse(input.body.toString('utf8')) as { value?: unknown }
      if (!Array.isArray(parsed?.value)) throw new Error('no value array')
      entries = parsed.value as GraphNotification[]
    } catch {
      throw new DriveNotificationInvalidError('the notification body is not a Graph change notification.')
    }
    if (entries.length === 0) throw new DriveNotificationInvalidError('the notification carried no entries.')

    const secrets: string[] = []
    const watchIds = new Set<string>()
    let changed = false
    for (const entry of entries) {
      const clientState = entry.clientState
      if (typeof clientState !== 'string' || clientState === '') {
        // Fail closed. Without `clientState` there is nothing authenticating
        // this delivery at all, and accepting it would hand an unauthenticated
        // caller a sync trigger for a connection they merely named.
        throw new DriveNotificationInvalidError('a notification entry carried no clientState.')
      }
      if (!secrets.includes(clientState)) secrets.push(clientState)
      if (typeof entry.subscriptionId === 'string' && entry.subscriptionId !== '') watchIds.add(entry.subscriptionId)
      // A lifecycle event (`reauthorizationRequired`, `subscriptionRemoved`) is
      // not a change: it means the subscription needs attention, and syncing on
      // it would be busywork. It is still a valid, authenticated delivery.
      if (typeof entry.changeType === 'string' && entry.changeType !== '') changed = true
    }

    const watchId = watchIds.size === 1 ? [...watchIds][0] : undefined
    return {
      ...(secrets.length === 1 ? { secret: secrets[0] as string } : { secrets }),
      ...(watchId !== undefined ? { watchId } : {}),
      changed,
      // Graph's driveItem notifications are content-free: they name the drive
      // root, never the item that changed. There is nothing honest to put in
      // `externalIds`, and inventing one would be a lie the sync then trusts.
    }
  }

  /**
   * No `retryAfterFromBody`.
   *
   * Graph always sends `Retry-After` with a `429` or a `503`, and its throttled
   * bodies (`{"error":{"code":"activityLimitReached"}}`) carry no number at
   * all. Declaring a parser that can only ever return `undefined` would make
   * the guarded fetch read a body it is otherwise right to destroy.
   */

  // ----------------------------------------------------------------- guts

  /** The connection's drive and folder, parsed and validated once per call. */
  private rootOf(session: DriveSession): MicrosoftRoot {
    return parseMicrosoftRoot(session.rootId, this.name)
  }

  /**
   * The resource a call should address: the connection's drive, optionally
   * narrowed to one folder inside it.
   *
   * A `folderId` may name a folder but **never another drive**: an
   * `externalId` is only unique within a drive, and letting a caller-supplied
   * folder handle carry a different `driveId` would let a connection scoped to
   * one library read another. A handle that tries is refused, not ignored.
   */
  private targetOf(session: DriveSession, folderId: string | undefined): MicrosoftRoot {
    const root = this.rootOf(session)
    if (folderId === undefined) return root
    const folder = parseMicrosoftRoot(folderId, this.name)
    if (
      (folder.driveId !== undefined && folder.driveId !== root.driveId) ||
      (folder.siteId !== undefined && folder.siteId !== root.siteId)
    ) {
      // The same refusal a malformed handle gets, on purpose: a caller learns
      // that the handle is not usable, not which of the two it was.
      throw invalidRootHandle(this.name)
    }
    return { ...root, ...(folder.itemId !== undefined ? { itemId: folder.itemId } : {}) }
  }

  /** One Graph call, mapped on failure. */
  private async call<T>(
    session: DriveSession,
    url: string,
    init: { method?: string; json?: unknown } = {},
    context: { externalId?: string | undefined; delta?: boolean | undefined } = {},
  ): Promise<T> {
    const response = await this.request(session, url, init)
    if (!response.ok) {
      await graphFailure(response, {
        provider: this.name,
        connectionId: session.connectionId,
        ...(context.externalId !== undefined ? { externalId: context.externalId } : {}),
        ...(context.delta !== undefined ? { delta: context.delta } : {}),
      })
    }
    return (await response.json()) as T
  }

  private async request(
    session: DriveSession,
    url: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<GuardedResponse> {
    return session.fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      // A metadata call has no business reading megabytes; the download cap is
      // a separate, much larger number.
      maxBytes: 8 * 1024 * 1024,
      ...(session.signal ? { signal: session.signal } : {}),
    })
  }

  private async readText(response: GuardedResponse): Promise<string> {
    try {
      return await response.text()
    } catch {
      response.destroy()
      return ''
    }
  }

  /**
   * The token endpoint.
   *
   * Goes through the **guarded** fetch like everything else: a token exchange
   * is as much an SSRF and timeout surface as a download, and it is the one
   * call that carries the client secret.
   */
  private async token(
    fetch: GuardedFetch,
    scopes: readonly string[] | undefined,
    fields: Record<string, string>,
  ): Promise<TokenResponse> {
    const form = new URLSearchParams({
      ...fields,
      client_id: this.options.clientId,
      ...(scopes !== undefined ? { scope: this.withOfflineAccess(scopes).join(' ') } : {}),
    })
    if (this.options.clientSecret !== undefined) form.set('client_secret', this.options.clientSecret)
    const response = await fetch(`${this.authority}/token`, {
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

  /**
   * `offline_access` is added if a caller forgot it.
   *
   * Not paternalism: a scope list without it produces a grant with no refresh
   * token, which fails at `exchange` with a message about `offline_access` —
   * after the user has already consented. Adding it is the difference between
   * a working connection and a consent screen the user has to visit twice.
   */
  private withOfflineAccess(scopes: readonly string[]): readonly string[] {
    return scopes.includes('offline_access') ? scopes : ['offline_access', ...scopes]
  }

  private tokensFrom(json: TokenResponse): DriveTokens {
    return {
      accessToken: json.access_token as string,
      ...(json.expires_in !== undefined ? { expiresAt: this.now() + json.expires_in * 1000 } : {}),
      // Present on every Microsoft response, because Microsoft rotates. The
      // engine compares it with the stored one and reports `rotated`.
      ...(json.refresh_token !== undefined ? { refreshToken: json.refresh_token } : {}),
      ...(json.scope !== undefined ? { scopes: json.scope.split(' ').filter(Boolean) } : {}),
    }
  }
}

/**
 * Builds the Microsoft OneDrive / SharePoint adapter.
 *
 * ```ts
 * drivesPlugin({
 *   providers: [
 *     microsoftDrive({
 *       clientId: env.MS_CLIENT_ID,
 *       clientSecret: env.MS_CLIENT_SECRET,
 *       tenant: 'common',
 *     }),
 *   ],
 *   keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
 *   secret: env.APP_SECRET,
 * })
 * ```
 */
export function microsoftDrive(options: MicrosoftDriveOptions): MicrosoftDrive {
  return new MicrosoftDrive(options)
}
