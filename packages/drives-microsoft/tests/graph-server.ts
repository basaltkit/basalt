import { Readable } from 'node:stream'
import type { Transport } from '@basaltkit/drives'

/**
 * A faithful fake of Microsoft Graph's HTTP surface, at the **transport** level.
 *
 * It is injected as the drives engine's `transport`, which means every request
 * still goes through the real guarded fetch: the host allowlist, the SSRF
 * validation, the redirect policy, the byte cap and the rate-limit handling are
 * all exercised, and only the socket is replaced. A fake at the `session.fetch`
 * level would have tested the adapter against a mock of the thing the adapter
 * is supposed to be constrained by.
 *
 * What it models, because these are the parts a naive stub gets wrong and a
 * real integration then discovers in production:
 *
 * - **Refresh-token rotation.** Every refresh issues a new refresh token and
 *   **retires the old one immediately**, which is what makes a stale concurrent
 *   writer fatal in the real world and is the whole reason the engine has a
 *   compare-and-set.
 * - `@odata.nextLink` and `@odata.deltaLink` as **complete URLs**, not tokens.
 * - A `/delta` with no token that enumerates first and only then hands over a
 *   `deltaLink` — `deltaIncludesExisting: true`.
 * - `410 resyncRequired` for a delta link that has aged out.
 * - Deletions as an id plus a `deleted` facet.
 * - `@microsoft.graph.downloadUrl` pointing at a **different host**, and
 *   `/content` answering `302` to that same host — the two SSRF shapes RFC 0002
 *   §5.1 was written for.
 * - `429` with `Retry-After`, and `401` for a stale access token.
 *
 * No network, no credentials, and nothing here is derived from live traffic —
 * see the README's "not verified against live traffic" list.
 */

const CDN_HOST = 'acme-my.sharepoint.com'

export interface FakeGraphFile {
  id: string
  name: string
  content: string
  /** Parent folder id. Absent means the drive root. */
  parentId?: string
  /** Display path of the PARENT, Graph style (`/drive/root:/Finance`). */
  parentPath?: string
  cTag?: string
  eTag?: string
  mimeType?: string
  /** Business/SharePoint hash. Mutually exclusive with `sha256` in practice. */
  quickXorHash?: string
  /** Personal OneDrive hash. */
  sha256?: string
  /** A OneNote notebook and friends: in the namespace, no bytes. */
  isPackage?: boolean
  /** A "Shared with me" shortcut: the bytes live in another drive. */
  isShortcut?: boolean
  isFolder?: boolean
}

interface Item {
  id: string
  name: string
  size?: number
  cTag?: string
  eTag?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  webUrl?: string
  folder?: { childCount: number }
  file?: { mimeType?: string; hashes?: Record<string, string> }
  package?: { type: string }
  remoteItem?: { id: string; driveId: string }
  deleted?: { state: string }
  parentReference?: { driveId: string; id?: string; path?: string }
}

export interface FakeGraphOptions {
  files?: readonly FakeGraphFile[]
  /** Items per page. Default 2 — small enough that paging is always exercised. */
  pageSize?: number
  accessTokens?: readonly string[]
  refreshTokens?: readonly string[]
  clientId?: string
  tenant?: string
  driveId?: string
  /**
   * Host the pre-signed URL and the `/content` redirect point at.
   *
   * Overridden by the SSRF tests to model a provider response that names a
   * look-alike host or the bare parent domain — the two cases the `.suffix`
   * allowlist rule exists for.
   */
  downloadHost?: string
  /**
   * What the user actually consented to, as Entra ID reports it back.
   *
   * The token endpoint never learns this from the request: the authorization
   * code carries it. So the fake models it as server-side state, the way Graph
   * does — which is also what makes "a refresh may not ask for more than was
   * granted" testable.
   */
  grantedScopes?: string
}

/** One recorded request, so a test can assert on what actually went on the wire. */
export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export class FakeGraph {
  readonly requests: RecordedRequest[] = []
  /** Subscriptions the fake currently holds, by id. */
  readonly subscriptions = new Map<string, { clientState: string; resource: string; expirationDateTime: string }>()
  /** Refresh tokens issued over this fake's lifetime, newest last. */
  readonly issuedRefreshTokens: string[] = []
  /** Delta links the fake still considers valid. Clearing one models an expiry. */
  private readonly liveDeltaLinks = new Set<string>()
  private readonly queued: { status: number; headers?: Record<string, string>; body: string }[] = []
  private readonly files = new Map<string, Item & { content: string }>()
  /** Append-only change log; a delta link is an index into it. */
  private readonly log: Item[] = []
  private readonly accessTokens: Set<string>
  private readonly refreshTokens: Set<string>
  private counter = 0
  readonly driveId: string
  readonly cdnHost: string

  constructor(private readonly options: FakeGraphOptions = {}) {
    this.accessTokens = new Set(options.accessTokens ?? ['access-1'])
    this.refreshTokens = new Set(options.refreshTokens ?? ['refresh-1'])
    this.driveId = options.driveId ?? 'b!acme-drive'
    this.cdnHost = options.downloadHost ?? CDN_HOST
    for (const file of options.files ?? []) this.put(file)
    // Seeded files are the baseline the first /delta enumerates.
    this.log.length = 0
    for (const entry of this.files.values()) this.log.push(strip(entry))
  }

  put(file: FakeGraphFile): void {
    const hashes: Record<string, string> = {}
    if (file.quickXorHash !== undefined) hashes['quickXorHash'] = file.quickXorHash
    if (file.sha256 !== undefined) hashes['sha256Hash'] = file.sha256
    const item: Item & { content: string } = {
      id: file.id,
      name: file.name,
      size: Buffer.byteLength(file.content),
      cTag: file.cTag ?? `"c:{${++this.counter}},1"`,
      eTag: file.eTag ?? `"{${this.counter}},2"`,
      createdDateTime: '2026-06-01T10:00:00Z',
      lastModifiedDateTime: '2026-06-01T10:00:00Z',
      webUrl: `https://${CDN_HOST}/Documents/${encodeURIComponent(file.name)}`,
      parentReference: {
        driveId: this.driveId,
        ...(file.parentId !== undefined ? { id: file.parentId } : { id: 'root!0' }),
        path: file.parentPath ?? '/drive/root:',
      },
      content: file.content,
      ...(file.isFolder === true
        ? { folder: { childCount: 0 } }
        : { file: { mimeType: file.mimeType ?? 'text/plain', ...(Object.keys(hashes).length > 0 ? { hashes } : {}) } }),
      ...(file.isPackage === true ? { package: { type: 'oneNote' } } : {}),
      ...(file.isShortcut === true ? { remoteItem: { id: `remote-${file.id}`, driveId: 'b!somebody-else' } } : {}),
    }
    this.files.set(file.id, item)
    this.log.push(strip(item))
  }

  /** Deletes a file. Graph reports this with the item's **id** plus a `deleted` facet. */
  remove(id: string): void {
    const entry = this.files.get(id)
    if (!entry) throw new Error(`fake graph has no item "${id}"`)
    this.files.delete(id)
    this.log.push({ id: entry.id, name: entry.name, deleted: { state: 'deleted' } })
  }

  expireAccessToken(token: string): void {
    this.accessTokens.delete(token)
  }

  /** Withdraws consent: every refresh token stops working. */
  revokeGrant(): void {
    this.refreshTokens.clear()
  }

  /** Ages out every delta link handed out so far — the `410 resyncRequired` case. */
  expireDeltaLinks(): void {
    this.liveDeltaLinks.clear()
  }

  /**
   * Makes the next `n` calls to the CONTENT host fail with 403 and a body that
   * quotes the pre-signed URL — the shape a real CDN error page has, and the
   * reason nothing from it may be forwarded into an error.
   */
  failCdnCalls = 0

  /** Makes the next call answer with this response instead of doing its job. */
  queue(status: number, body: string, headers: Record<string, string> = {}): void {
    this.queued.push({ status, body, headers })
  }

  /** The transport to hand to `new Drives({ transport })`. */
  get transport(): Transport {
    return async (url, init) => {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(init.headers)) headers[key.toLowerCase()] = value
      const body = typeof init.body === 'string' ? init.body : await collect(init.body)
      this.requests.push({ method: init.method, url: url.toString(), headers, body })

      const queued = this.queued.shift()
      if (queued) return reply(queued.status, queued.body, queued.headers)
      return this.route(init.method, url, headers, body)
    }
  }

  private route(method: string, url: URL, headers: Record<string, string>, body: string): TransportReply {
    const host = url.hostname
    const path = url.pathname

    if (host === 'login.microsoftonline.com') {
      if (path.endsWith('/oauth2/v2.0/token')) return this.token(path, body)
      return json(404, { error: 'not_found' })
    }
    if (host === this.cdnHost) {
      // The pre-signed content host. It authenticates with the URL, never with
      // a bearer token — and the test suite asserts we never send one.
      return this.cdn(url, headers)
    }
    if (host !== 'graph.microsoft.com') return json(404, { error: { code: 'unknownHost' } })

    return this.authed(headers, () => {
      // `/me`
      if (path === '/v1.0/me') {
        return json(200, {
          id: 'ms-user-1',
          displayName: 'Acme Finance',
          mail: 'finance@acme.test',
          userPrincipalName: 'finance@acme.test',
        })
      }
      if (path === '/v1.0/subscriptions') return this.createSubscription(method, body)
      if (path.startsWith('/v1.0/subscriptions/')) return this.deleteSubscription(method, path)

      const resource = path.slice('/v1.0'.length)
      if (resource.endsWith('/children')) return this.children(url)
      if (resource.endsWith('/delta')) return this.delta(url)
      if (resource.endsWith('/content')) return this.content(method, resource, body, headers)
      const item = this.itemOf(resource)
      if (item !== undefined) return json(200, this.projected(item, url))
      return json(404, { error: { code: 'itemNotFound', message: `Item not found: ${resource}` } })
    })
  }

  private authed(headers: Record<string, string>, handler: () => TransportReply): TransportReply {
    const auth = headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!this.accessTokens.has(token)) {
      return json(401, {
        error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired or is not yet valid.' },
      })
    }
    return handler()
  }

  // ---------------------------------------------------------------- OAuth

  private token(path: string, body: string): TransportReply {
    const tenant = path.split('/')[1]
    if (this.options.tenant !== undefined && tenant !== this.options.tenant) {
      return json(400, { error: 'invalid_request', error_description: 'AADSTS900023: wrong tenant' })
    }
    const form = new URLSearchParams(body)
    if (form.get('client_id') !== (this.options.clientId ?? 'client-id')) {
      return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215' })
    }
    const granted = this.options.grantedScopes ?? 'offline_access User.Read Files.Read'
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' })
      if (!form.get('code_verifier')) return json(400, { error: 'invalid_request' })
      if (!granted.split(' ').includes('offline_access')) {
        // Without offline_access Entra ID simply omits the refresh token.
        return json(200, { access_token: this.mintAccess(), token_type: 'Bearer', expires_in: 3600 })
      }
      return json(200, {
        access_token: this.mintAccess(),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: this.mintRefresh(),
        scope: granted,
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? ''
      const asked = (form.get('scope') ?? '').split(' ').filter(Boolean)
      if (asked.some((scope) => !granted.split(' ').includes(scope))) {
        // Entra ID refuses a refresh that asks for more than the grant holds.
        return json(400, { error: 'invalid_grant', error_description: 'AADSTS65001: scope not consented' })
      }
      if (!this.refreshTokens.has(presented)) {
        // The answer for a revoked grant AND for a token another worker already
        // rotated away. They are indistinguishable here, which is the point.
        return json(400, { error: 'invalid_grant', error_description: 'AADSTS700082', error_codes: [700082] })
      }
      // ROTATION: the presented token dies the instant a new one is issued.
      this.refreshTokens.delete(presented)
      return json(200, {
        access_token: this.mintAccess(),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: this.mintRefresh(),
        scope: form.get('scope') ?? granted,
      })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private mintAccess(): string {
    const token = `access-${++this.counter}`
    this.accessTokens.add(token)
    return token
  }

  private mintRefresh(): string {
    const token = `refresh-${++this.counter}`
    this.refreshTokens.add(token)
    this.issuedRefreshTokens.push(token)
    return token
  }

  // ------------------------------------------------------------- resources

  /** `/me/drive/root`, `/drives/{id}/root`, `/drives/{id}/items/{id}`, … */
  private itemOf(resource: string): (Item & { content?: string }) | undefined {
    const base = resource.replace(/\/(children|delta|content)$/, '')
    if (base.endsWith('/root')) {
      return { id: 'root!0', name: 'root', folder: { childCount: this.files.size } }
    }
    const marker = base.lastIndexOf('/items/')
    if (marker === -1) return undefined
    const id = decodeURIComponent(base.slice(marker + '/items/'.length))
    return this.files.get(id)
  }

  /** Applies `$select` the way Graph does, including the downloadUrl opt-in. */
  private projected(item: Item & { content?: string }, url: URL): Record<string, unknown> {
    const select = url.searchParams.get('$select')
    const projected = strip(item) as unknown as Record<string, unknown>
    if (select === null) {
      if (item.content !== undefined && item.package === undefined && item.remoteItem === undefined) {
        projected['@microsoft.graph.downloadUrl'] = this.downloadUrl(item.id)
      }
      return projected
    }
    const fields = new Set(select.split(','))
    const picked: Record<string, unknown> = {}
    for (const field of fields) {
      if (field === '@microsoft.graph.downloadUrl') {
        if (item.content !== undefined && item.package === undefined && item.remoteItem === undefined) {
          picked[field] = this.downloadUrl(item.id)
        }
        continue
      }
      if (projected[field] !== undefined) picked[field] = projected[field]
    }
    return picked
  }

  /**
   * A pre-signed URL on a **different host**, carrying its own short-lived
   * token in the query string — exactly the shape that makes this a bearer
   * credential rather than a link.
   */
  private downloadUrl(id: string): string {
    return `https://${this.cdnHost}/personal/finance/_layouts/15/download.aspx?UniqueId=${encodeURIComponent(id)}&tempauth=PRESIGNED-SECRET-${id}`
  }

  private children(url: URL): TransportReply {
    const resource = url.pathname.slice('/v1.0'.length).replace(/\/children$/, '')
    const parent = resource.endsWith('/root') ? 'root!0' : (this.itemOf(`${resource}/children`)?.id ?? 'root!0')
    const within = [...this.files.values()].filter(
      (item) => (item.parentReference?.id ?? 'root!0') === parent,
    )
    const from = Number(url.searchParams.get('$skiptoken') ?? '0')
    const size = this.options.pageSize ?? 2
    const slice = within.slice(from, from + size)
    const next = from + slice.length
    return json(200, {
      value: slice.map((item) => this.projected(item, url)),
      ...(next < within.length
        ? {
            // A COMPLETE URL, not a token — the difference this adapter's
            // opaque cursor exists to absorb.
            '@odata.nextLink': `https://graph.microsoft.com/v1.0${resource}/children?$top=${size}&$select=${encodeURIComponent(url.searchParams.get('$select') ?? '')}&$skiptoken=${next}`,
          }
        : {}),
    })
  }

  private delta(url: URL): TransportReply {
    const resource = url.pathname.slice('/v1.0'.length).replace(/\/delta$/, '')
    const raw = url.searchParams.get('token')
    if (raw !== null && !this.liveDeltaLinks.has(url.toString())) {
      return json(410, {
        error: { code: 'resyncRequired', message: 'Resync required. Replace any local items with the server copy.' },
      })
    }
    const from = raw === null ? 0 : Number(raw)
    const size = this.options.pageSize ?? 2
    const slice = this.log.slice(from, from + size)
    const next = from + slice.length
    const link = `https://graph.microsoft.com/v1.0${resource}/delta?token=${next}`
    this.liveDeltaLinks.add(link)
    return json(200, {
      value: slice,
      ...(next < this.log.length ? { '@odata.nextLink': link } : { '@odata.deltaLink': link }),
    })
  }

  /**
   * `/content`: a `302` to the content host, exactly as Graph answers it. The
   * guarded fetch follows the hop, re-validates it — and must not carry the
   * Graph bearer token across.
   */
  private content(method: string, resource: string, body: string, headers: Record<string, string>): TransportReply {
    if (method === 'PUT') return this.upload(resource, body, headers)
    const item = this.itemOf(resource)
    if (!item || item.content === undefined) {
      return json(404, { error: { code: 'itemNotFound' } })
    }
    return { status: 302, headers: { location: this.downloadUrl(item.id) }, body: Readable.from([]) }
  }

  private upload(resource: string, body: string, headers: Record<string, string>): TransportReply {
    // `…/root:/name.txt:/content` or `…/items/{id}:/name.txt:/content`
    const match = /:\/([^/]+):\/content$/.exec(resource)
    const name = decodeURIComponent(match?.[1] ?? 'untitled')
    const id = `01UPLOAD${++this.counter}`
    this.put({ id, name, content: body, mimeType: headers['content-type'] ?? 'application/octet-stream' })
    return json(201, strip(this.files.get(id)!))
  }

  private cdn(url: URL, headers: Record<string, string>): TransportReply {
    if (this.failCdnCalls > 0) {
      this.failCdnCalls--
      return reply(403, `<Error>the link ${url.toString()} has expired</Error>`, { 'content-type': 'text/html' })
    }
    const id = url.searchParams.get('UniqueId') ?? ''
    const entry = this.files.get(id)
    if (!entry || entry.content === undefined) return reply(404, 'not found', { 'content-type': 'text/plain' })
    if (!(url.searchParams.get('tempauth') ?? '').startsWith('PRESIGNED-SECRET-')) {
      return reply(403, 'forbidden', { 'content-type': 'text/plain' })
    }
    return {
      status: 200,
      headers: {
        'content-type': entry.file?.mimeType ?? 'application/octet-stream',
        // Recorded so a test can prove no Authorization header arrived here.
        'x-fake-saw-authorization': headers['authorization'] === undefined ? 'no' : 'yes',
      },
      body: Readable.from([Buffer.from(entry.content, 'utf8')]),
    }
  }

  // -------------------------------------------------------- subscriptions

  private createSubscription(method: string, body: string): TransportReply {
    if (method !== 'POST') return json(405, { error: { code: 'methodNotAllowed' } })
    const input = JSON.parse(body) as {
      notificationUrl?: string
      clientState?: string
      resource?: string
      expirationDateTime?: string
      changeType?: string
    }
    if (!input.notificationUrl || !input.clientState || !input.resource) {
      return json(400, { error: { code: 'invalidRequest' } })
    }
    const id = `sub-${++this.counter}`
    const expirationDateTime = input.expirationDateTime ?? '2026-07-01T00:00:00Z'
    this.subscriptions.set(id, {
      clientState: input.clientState,
      resource: input.resource,
      expirationDateTime,
    })
    return json(201, {
      id,
      resource: input.resource,
      changeType: input.changeType,
      notificationUrl: input.notificationUrl,
      expirationDateTime,
      // Graph echoes clientState back on creation. It is never logged here.
      clientState: input.clientState,
    })
  }

  private deleteSubscription(method: string, path: string): TransportReply {
    const id = path.slice('/v1.0/subscriptions/'.length)
    if (method !== 'DELETE') return json(405, { error: { code: 'methodNotAllowed' } })
    if (!this.subscriptions.has(id)) return json(404, { error: { code: 'ResourceNotFound' } })
    this.subscriptions.delete(id)
    return { status: 204, headers: {}, body: Readable.from([]) }
  }
}

type TransportReply = { status: number; headers: Record<string, string>; body: Readable }

function reply(status: number, body: string, headers: Record<string, string> = {}): TransportReply {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Readable.from([Buffer.from(body)]),
  }
}

function json(status: number, value: unknown): TransportReply {
  return reply(status, JSON.stringify(value))
}

function strip(item: Item & { content?: string }): Item {
  const { content: _content, ...rest } = item
  return rest
}

async function collect(body: unknown): Promise<string> {
  if (body === undefined) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
