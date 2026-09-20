import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Transport } from '@basaltkit/drives'

/**
 * A faithful fake of Google Drive's HTTP surface, at the **transport** level.
 *
 * It is injected as the drives engine's `transport`, so every request still
 * goes through the real guarded fetch: the host allowlist, the SSRF validation,
 * the redirect policy, the byte cap and the rate-limit handling are all
 * exercised, and only the socket is replaced. A fake at the `session.fetch`
 * level would have tested the adapter against a mock of the very thing the
 * adapter is supposed to be constrained by.
 *
 * What it models, because these are the parts a naive stub gets wrong and a
 * real integration then discovers in production:
 *
 * - **`files.get?alt=media` answers `302` to `*.googleusercontent.com`** with a
 *   signed URL, and the CDN host serves the bytes. This is the SSRF case the
 *   whole guarded-fetch design exists for, and it only gets tested if the fake
 *   actually redirects.
 * - **`changes.getStartPageToken` means "from now"** — the seeded corpus is
 *   *not* in the change log ahead of that token, so an adapter that declared
 *   `deltaIncludesExisting: true` would import nothing and the test would say so.
 * - **A throttle is a `403`** with `reason: userRateLimitExceeded`, not a 429.
 * - **A hard deletion carries no `file` resource**, while a trash carries a
 *   full one with `trashed: true`.
 * - **An aged-out `pageToken`** answers `400 invalid`.
 * - Google-native documents with **no `md5Checksum` and no `size`**.
 *
 * No network, no credentials, and nothing here is derived from live traffic —
 * see the README's "not verifiable without live traffic" list.
 */

export interface FakeGoogleFile {
  id: string
  name: string
  content?: string
  mimeType?: string
  parents?: string[]
  headRevisionId?: string
  createdTime?: string
  modifiedTime?: string
  webViewLink?: string
  trashed?: boolean
}

interface Entry {
  id: string
  name: string
  mimeType: string
  parents: string[]
  size?: string
  md5Checksum?: string
  headRevisionId?: string
  createdTime: string
  modifiedTime: string
  webViewLink?: string
  trashed?: boolean
  content: string
}

interface ChangeEntry {
  fileId: string
  removed?: boolean
  file?: Record<string, unknown>
  changeType?: string
  time: string
}

export interface FakeGoogleOptions {
  files?: readonly FakeGoogleFile[]
  /** Entries per page. Default 2 — small enough that paging is always exercised. */
  pageSize?: number
  accessTokens?: readonly string[]
  refreshTokens?: readonly string[]
  clientId?: string
  /** Host the download redirect points at. Default a real-shaped CDN subdomain. */
  redirectHost?: string
  /** Serve bytes straight from the API host instead of redirecting. */
  directDownload?: boolean
}

/** One recorded request, so a test can assert on what actually went on the wire. */
export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DOC_MIME = 'application/vnd.google-apps.document'
export const CDN_HOST = 'doc-04-7g-docs.googleusercontent.com'

export class FakeGoogle {
  readonly requests: RecordedRequest[] = []
  /** Channels registered through `changes.watch`. */
  readonly channels = new Map<string, { address: string; token: string; expiration: number; resourceId: string }>()
  /** Queued responses that pre-empt the normal handling — throttles, outages. */
  private readonly queued: { status: number; headers?: Record<string, string>; body: string }[] = []
  private readonly files = new Map<string, Entry>()
  /** Append-only change log; a page token is an index into it. */
  private readonly log: ChangeEntry[] = []
  private readonly accessTokens: Set<string>
  private readonly refreshTokens: Set<string>
  /** Page tokens below this are "aged out" and answer 400. */
  private watermark = 0
  private counter = 0
  /** When set, the next N API calls answer 403 userRateLimitExceeded. */
  throttleNextCalls = 0

  constructor(private readonly options: FakeGoogleOptions = {}) {
    this.accessTokens = new Set(options.accessTokens ?? ['access-1'])
    this.refreshTokens = new Set(options.refreshTokens ?? ['refresh-1'])
    for (const file of options.files ?? []) this.put(file)
    // Seeded files are the baseline the backfill listing enumerates. They are
    // NOT in the change log: `changes.getStartPageToken` is "from now on", and
    // pretending otherwise is the single mistake this adapter's
    // `deltaIncludesExisting: false` exists to prevent.
    this.log.length = 0
  }

  put(file: FakeGoogleFile): Entry {
    const content = file.content ?? ''
    const mimeType = file.mimeType ?? 'application/pdf'
    const native = mimeType.startsWith('application/vnd.google-apps.') && mimeType !== FOLDER_MIME
    const entry: Entry = {
      id: file.id,
      name: file.name,
      mimeType,
      parents: file.parents ?? [],
      // A Google-native document has neither, and a folder has no md5 either.
      ...(native || mimeType === FOLDER_MIME ? {} : { size: String(Buffer.byteLength(content)) }),
      ...(native || mimeType === FOLDER_MIME ? {} : { md5Checksum: md5(content) }),
      ...(native || mimeType === FOLDER_MIME
        ? {}
        : { headRevisionId: file.headRevisionId ?? `rev-${++this.counter}` }),
      createdTime: file.createdTime ?? '2026-06-01T10:00:00.000Z',
      modifiedTime: file.modifiedTime ?? '2026-06-01T10:00:00.000Z',
      webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      ...(file.trashed === true ? { trashed: true } : {}),
      content,
    }
    this.files.set(file.id, entry)
    this.log.push({ fileId: file.id, file: resource(entry), time: entry.modifiedTime })
    return entry
  }

  /** Changes a file's content, bumping its head revision — the "re-import me" case. */
  edit(id: string, content: string): void {
    const current = this.files.get(id)
    if (!current) throw new Error(`fake google has no file "${id}"`)
    this.put({
      id,
      name: current.name,
      content,
      mimeType: current.mimeType,
      parents: current.parents,
      headRevisionId: `rev-${++this.counter}`,
    })
  }

  /** The ordinary Drive delete: the resource survives, with `trashed: true`. */
  trash(id: string): void {
    const entry = this.files.get(id)
    if (!entry) throw new Error(`fake google has no file "${id}"`)
    entry.trashed = true
    this.log.push({ fileId: id, file: resource(entry), time: '2026-06-02T10:00:00.000Z' })
  }

  /**
   * A hard deletion (or a lost share): `{fileId, removed: true}` and **no file
   * resource at all**, which is what makes it unscopable for a root-confined
   * connection.
   */
  remove(id: string): void {
    this.files.delete(id)
    this.log.push({ fileId: id, removed: true, time: '2026-06-02T10:00:00.000Z' })
  }

  /** Ages out every page token handed out so far. */
  expireCursors(): void {
    this.watermark = this.log.length + 1
  }

  expireAccessToken(token: string): void {
    this.accessTokens.delete(token)
  }

  revokeGrant(): void {
    this.refreshTokens.clear()
  }

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
      return this.route(url, headers, body)
    }
  }

  private route(url: URL, headers: Record<string, string>, body: string): TransportReply {
    const path = `${url.hostname}${url.pathname}`
    if (url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'googleusercontent.com') {
      return this.cdn(url)
    }
    switch (path) {
      case 'oauth2.googleapis.com/token':
        return this.token(body)
      case 'oauth2.googleapis.com/revoke':
        this.refreshTokens.clear()
        return reply(200, '{}')
      case 'www.googleapis.com/drive/v3/about':
        return this.authed(headers, () =>
          json(200, {
            user: { displayName: 'Acme Finance', emailAddress: 'finance@acme.test', permissionId: '1122334455' },
          }),
        )
      case 'www.googleapis.com/drive/v3/files':
        return this.authed(headers, () => this.listFiles(url))
      case 'www.googleapis.com/upload/drive/v3/files':
        return this.authed(headers, () => this.upload(headers, body))
      case 'www.googleapis.com/drive/v3/changes':
        return this.authed(headers, () => this.changes(url))
      case 'www.googleapis.com/drive/v3/changes/startPageToken':
        return this.authed(headers, () => json(200, { startPageToken: String(this.log.length), kind: 'drive#startPageToken' }))
      case 'www.googleapis.com/drive/v3/changes/watch':
        return this.authed(headers, () => this.watch(body))
      case 'www.googleapis.com/drive/v3/channels/stop':
        return this.authed(headers, () => this.stop(body))
      default: {
        const match = /^www\.googleapis\.com\/drive\/v3\/files\/([^/]+)$/.exec(path)
        if (match) {
          return this.authed(headers, () =>
            url.searchParams.get('alt') === 'media'
              ? this.download(decodeURIComponent(match[1] as string))
              : this.metadata(decodeURIComponent(match[1] as string)),
          )
        }
        return googleError(404, 'notFound', 'Not Found')
      }
    }
  }

  private authed(headers: Record<string, string>, handler: () => TransportReply): TransportReply {
    const auth = headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!this.accessTokens.has(token)) {
      return googleError(401, 'authError', 'Invalid Credentials')
    }
    if (this.throttleNextCalls > 0) {
      this.throttleNextCalls--
      // The shape that matters: Google throttles with 403, not 429.
      return googleError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded', 'usageLimits')
    }
    return handler()
  }

  private token(body: string): TransportReply {
    const form = new URLSearchParams(body)
    if (form.get('client_id') !== (this.options.clientId ?? 'client-id')) {
      return json(400, { error: 'invalid_client', error_description: 'The OAuth client was not found.' })
    }
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' })
      if (!form.get('code_verifier')) return json(400, { error: 'invalid_request' })
      const refresh = 'refresh-1'
      this.refreshTokens.add(refresh)
      return json(200, {
        access_token: this.mintAccess(),
        expires_in: 3599,
        refresh_token: refresh,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        token_type: 'Bearer',
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? ''
      if (!this.refreshTokens.has(presented)) {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      }
      // Google does NOT rotate: no refresh_token in the response.
      return json(200, {
        access_token: this.mintAccess(),
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        token_type: 'Bearer',
      })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private mintAccess(): string {
    const token = `access-${++this.counter}`
    this.accessTokens.add(token)
    return token
  }

  private listFiles(url: URL): TransportReply {
    const q = url.searchParams.get('q') ?? ''
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    const all = [...this.files.values()]
      .filter((entry) => entry.trashed !== true)
      .filter((entry) => (parent === undefined ? true : entry.parents.includes(parent)))
      .sort((a, b) => a.id.localeCompare(b.id))
    const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), this.options.pageSize ?? 2)
    const from = Number(url.searchParams.get('pageToken') ?? '0')
    if (!Number.isInteger(from) || from < 0) return googleError(400, 'invalid', 'Invalid Value')
    const slice = all.slice(from, from + size)
    const next = from + slice.length
    return json(200, {
      files: slice.map(resource),
      ...(next < all.length ? { nextPageToken: String(next) } : {}),
    })
  }

  private metadata(id: string): TransportReply {
    const entry = this.files.get(id)
    if (!entry) return googleError(404, 'notFound', 'File not found.')
    return json(200, resource(entry))
  }

  private download(id: string): TransportReply {
    const entry = this.files.get(id)
    if (!entry) return googleError(404, 'notFound', 'File not found.')
    if (entry.mimeType.startsWith('application/vnd.google-apps.')) {
      // What Drive really answers for a Doc: there are no bytes to serve.
      return googleError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.')
    }
    if (this.options.directDownload === true) {
      return {
        status: 200,
        headers: { 'content-type': entry.mimeType, 'content-length': String(Buffer.byteLength(entry.content)) },
        body: Readable.from([Buffer.from(entry.content, 'utf8')]),
      }
    }
    // The real shape: a 302 to a signed, single-use URL on a CDN host.
    const host = this.options.redirectHost ?? CDN_HOST
    return {
      status: 302,
      headers: {
        location: `https://${host}/download/${encodeURIComponent(id)}?e=download&sig=${md5(`sig:${id}`)}`,
        'content-type': 'text/html',
      },
      body: Readable.from([Buffer.from('<html>Moved</html>')]),
    }
  }

  private cdn(url: URL): TransportReply {
    const id = decodeURIComponent(url.pathname.replace('/download/', ''))
    const entry = this.files.get(id)
    if (!entry) return googleError(404, 'notFound', 'File not found.')
    return {
      status: 200,
      headers: { 'content-type': entry.mimeType, 'content-length': String(Buffer.byteLength(entry.content)) },
      body: Readable.from([Buffer.from(entry.content, 'utf8')]),
    }
  }

  private upload(headers: Record<string, string>, body: string): TransportReply {
    const boundary = /boundary=([^;]+)/.exec(headers['content-type'] ?? '')?.[1]
    if (boundary === undefined) return googleError(400, 'badRequest', 'Bad multipart.')
    const parts = body.split(`--${boundary}`)
    const metaPart = parts[1] ?? ''
    const contentPart = parts[2] ?? ''
    const metadata = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim()) as {
      name?: string
      mimeType?: string
      parents?: string[]
    }
    const content = contentPart.slice(contentPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
    const id = `upload-${++this.counter}`
    const entry = this.put({
      id,
      name: metadata.name ?? 'untitled',
      mimeType: metadata.mimeType ?? 'application/octet-stream',
      content,
      ...(metadata.parents !== undefined ? { parents: metadata.parents } : {}),
    })
    return json(200, resource(entry))
  }

  private changes(url: URL): TransportReply {
    const token = url.searchParams.get('pageToken')
    const from = Number(token)
    if (token === null || !Number.isInteger(from) || from < 0 || from < this.watermark || from > this.log.length) {
      // What an aged-out token really looks like: Google has no distinct code
      // for it, so it is simply an invalid value.
      return googleError(400, 'invalid', 'Invalid Value')
    }
    const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), this.options.pageSize ?? 2)
    const slice = this.log.slice(from, from + size)
    const next = from + slice.length
    return json(200, {
      changes: slice,
      ...(next < this.log.length
        ? { nextPageToken: String(next) }
        : { newStartPageToken: String(this.log.length) }),
    })
  }

  private watch(body: string): TransportReply {
    const input = JSON.parse(body) as { id?: string; address?: string; token?: string; params?: { ttl?: string } }
    if (input.id === undefined || input.address === undefined) return googleError(400, 'required', 'Missing channel id.')
    const ttl = Number(input.params?.ttl ?? 3600)
    // Google caps the TTL and answers with the expiration it actually chose.
    const expiration = Date.parse('2026-06-01T00:00:00Z') + Math.min(ttl, 24 * 60 * 60) * 1000
    const resourceId = `resource-${++this.counter}`
    this.channels.set(input.id, {
      address: input.address,
      token: input.token ?? '',
      expiration,
      resourceId,
    })
    return json(200, {
      kind: 'api#channel',
      id: input.id,
      resourceId,
      resourceUri: `https://www.googleapis.com/drive/v3/changes?pageToken=99&alt=json`,
      token: input.token,
      expiration: String(expiration),
    })
  }

  private stop(body: string): TransportReply {
    const input = JSON.parse(body) as { id?: string; resourceId?: string }
    const channel = input.id !== undefined ? this.channels.get(input.id) : undefined
    if (!channel || channel.resourceId !== input.resourceId) {
      return googleError(404, 'notFound', 'Channel not found.')
    }
    this.channels.delete(input.id as string)
    return { status: 204, headers: {}, body: Readable.from([]) }
  }

  /**
   * Builds a well-formed notification for a registered channel — the `X-Goog-*`
   * headers and an empty body, which is all Google sends.
   */
  notificationFor(
    channelId: string,
    options: { state?: string; messageNumber?: number; token?: string } = {},
  ): { method: string; headers: Record<string, string | undefined>; query: Record<string, string | undefined>; body: Buffer } {
    const channel = this.channels.get(channelId)
    if (!channel) throw new Error(`fake google has no channel "${channelId}"`)
    return {
      method: 'POST',
      headers: {
        'x-goog-channel-id': channelId,
        'x-goog-channel-token': options.token ?? channel.token,
        'x-goog-resource-id': channel.resourceId,
        'x-goog-resource-state': options.state ?? 'change',
        'x-goog-message-number': String(options.messageNumber ?? 2),
      },
      query: {},
      body: Buffer.alloc(0),
    }
  }
}

type TransportReply = { status: number; headers: Record<string, string>; body: Readable }

function reply(status: number, body: string, headers: Record<string, string> = {}): TransportReply {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
    body: Readable.from([Buffer.from(body)]),
  }
}

function json(status: number, value: unknown): TransportReply {
  return reply(status, JSON.stringify(value))
}

/** Google's error envelope, the shape the adapter's `reason` extraction reads. */
export function googleError(status: number, reason: string, message: string, domain = 'global'): TransportReply {
  return json(status, {
    error: { errors: [{ domain, reason, message }], code: status, message },
  })
}

function resource(entry: Entry): Record<string, unknown> {
  const { content: _content, ...rest } = entry
  return rest
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

async function collect(body: unknown): Promise<string> {
  if (body === undefined) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
