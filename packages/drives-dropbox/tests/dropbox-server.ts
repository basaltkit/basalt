import { Readable } from 'node:stream'
import type { Transport } from '@basaltkit/drives'
import { dropboxContentHash } from '../src/content-hash.js'

/**
 * A faithful fake of Dropbox's HTTP surface, at the **transport** level.
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
 * - `list_folder` / `continue` cursor semantics, including a cursor that keeps
 *   working after `has_more` goes false and then yields *changes*.
 * - `deleted` entries with **no id**.
 * - `409` with an `error_summary` for endpoint errors, `401` for a stale token.
 * - `429` with `Retry-After`, and `429` with the hint only in the body.
 * - `Dropbox-API-Arg` arriving as an ASCII-escaped header, and `content_hash`
 *   computed the way Dropbox computes it.
 *
 * No network, no credentials, and nothing here is derived from live traffic —
 * see the report's "not verifiable without a real app" list.
 */

export interface FakeDropboxFile {
  id: string
  path: string
  content: string
  rev?: string
  isDownloadable?: boolean
  clientModified?: string
  serverModified?: string
}

interface Entry {
  '.tag': 'file' | 'folder' | 'deleted'
  id?: string
  name: string
  path_lower: string
  path_display: string
  rev?: string
  size?: number
  content_hash?: string
  client_modified?: string
  server_modified?: string
  is_downloadable?: boolean
}

export interface FakeDropboxOptions {
  files?: readonly FakeDropboxFile[]
  /** Entries per `list_folder` page. Default 2 — small enough that paging is always exercised. */
  pageSize?: number
  /** Access tokens the fake will accept. */
  accessTokens?: readonly string[]
  /** Refresh tokens the fake will accept. */
  refreshTokens?: readonly string[]
  appKey?: string
  appSecret?: string
}

/** One recorded request, so a test can assert on what actually went on the wire. */
export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export class FakeDropbox {
  readonly requests: RecordedRequest[] = []
  /** Queued responses that pre-empt the normal handling — rate limits, outages. */
  private readonly queued: { status: number; headers?: Record<string, string>; body: string }[] = []
  private readonly files = new Map<string, Entry & { content: string }>()
  /** Append-only log; a cursor is an index into it. */
  private readonly log: Entry[] = []
  private readonly accessTokens: Set<string>
  private readonly refreshTokens: Set<string>
  private counter = 0

  constructor(private readonly options: FakeDropboxOptions = {}) {
    this.accessTokens = new Set(options.accessTokens ?? ['access-1'])
    this.refreshTokens = new Set(options.refreshTokens ?? ['refresh-1'])
    for (const file of options.files ?? []) this.put(file)
    // Seeded files are the baseline the first list_folder enumerates.
    this.log.length = 0
    for (const entry of this.files.values()) this.log.push(strip(entry))
  }

  put(file: FakeDropboxFile): void {
    const name = file.path.split('/').filter(Boolean).pop() ?? file.path
    const entry: Entry & { content: string } = {
      '.tag': 'file',
      id: file.id,
      name,
      path_lower: file.path.toLowerCase(),
      path_display: file.path,
      rev: file.rev ?? `0150${++this.counter}`,
      size: Buffer.byteLength(file.content),
      content_hash: dropboxContentHash(Buffer.from(file.content, 'utf8')),
      client_modified: file.clientModified ?? '2026-06-01T10:00:00Z',
      server_modified: file.serverModified ?? '2026-06-01T10:00:00Z',
      ...(file.isDownloadable === false ? { is_downloadable: false } : {}),
      content: file.content,
    }
    this.files.set(file.id, entry)
    this.log.push(strip(entry))
  }

  /** Deletes a file. Dropbox reports this with a path and **no id**. */
  remove(id: string): void {
    const entry = this.files.get(id)
    if (!entry) throw new Error(`fake dropbox has no file "${id}"`)
    this.files.delete(id)
    this.log.push({
      '.tag': 'deleted',
      name: entry.name,
      path_lower: entry.path_lower,
      path_display: entry.path_display,
    })
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

  private route(url: URL, headers: Record<string, string>, body: string) {
    const path = `${url.hostname}${url.pathname}`
    switch (path) {
      case 'api.dropboxapi.com/oauth2/token':
        return this.token(body)
      case 'api.dropboxapi.com/2/auth/token/revoke':
        return this.authed(headers, () => {
          this.refreshTokens.clear()
          return reply(200, '')
        })
      case 'api.dropboxapi.com/2/users/get_current_account':
        return this.authed(headers, () =>
          json(200, { account_id: 'dbid:AAH-ACME', email: 'finance@acme.test', name: { display_name: 'Acme Finance' } }),
        )
      case 'api.dropboxapi.com/2/files/list_folder':
        return this.authed(headers, () => this.listFolder(JSON.parse(body) as ListArg))
      case 'api.dropboxapi.com/2/files/list_folder/continue':
        return this.authed(headers, () => this.continueFrom((JSON.parse(body) as { cursor: string }).cursor))
      case 'api.dropboxapi.com/2/files/get_metadata':
        return this.authed(headers, () => this.metadata((JSON.parse(body) as { path: string }).path))
      case 'content.dropboxapi.com/2/files/download':
        return this.authed(headers, () => this.download(headers))
      case 'content.dropboxapi.com/2/files/upload':
        return this.authed(headers, () => this.upload(headers, body))
      default:
        return json(404, { error_summary: 'unknown_endpoint/' })
    }
  }

  private authed(headers: Record<string, string>, handler: () => TransportReply): TransportReply {
    const auth = headers['authorization'] ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!this.accessTokens.has(token)) {
      // Dropbox's own shape for a stale token.
      return json(401, { error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } })
    }
    return handler()
  }

  private token(body: string): TransportReply {
    const form = new URLSearchParams(body)
    if (form.get('client_id') !== (this.options.appKey ?? 'app-key')) {
      return json(400, { error: 'invalid_client' })
    }
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' })
      if (!form.get('code_verifier')) return json(400, { error: 'invalid_request' })
      const refresh = 'refresh-1'
      this.refreshTokens.add(refresh)
      const access = this.mintAccess()
      return json(200, {
        access_token: access,
        token_type: 'bearer',
        expires_in: 14_400,
        refresh_token: refresh,
        scope: 'account_info.read files.content.read files.metadata.read',
        account_id: 'dbid:AAH-ACME',
      })
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? ''
      if (!this.refreshTokens.has(presented)) return json(400, { error: 'invalid_grant' })
      // Dropbox does NOT rotate: no refresh_token in the response.
      return json(200, { access_token: this.mintAccess(), token_type: 'bearer', expires_in: 14_400 })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  private mintAccess(): string {
    const token = `access-${++this.counter}`
    this.accessTokens.add(token)
    return token
  }

  private listFolder(arg: ListArg): TransportReply {
    const within = [...this.files.values()].filter((entry) =>
      arg.path === '' ? true : entry.path_lower.startsWith(arg.path.toLowerCase()),
    )
    // The cursor is an index into the change log; `list_folder` starts at 0 and
    // the first page is the enumeration itself, exactly as Dropbox behaves.
    return this.page(0, arg.limit ?? 100, within.length)
  }

  private continueFrom(cursor: string): TransportReply {
    const index = Number(cursor.split(':')[1] ?? NaN)
    if (!Number.isInteger(index)) return json(400, { error_summary: 'reset/' })
    return this.page(index, this.options.pageSize ?? 2, this.log.length)
  }

  private page(from: number, limit: number, _total: number): TransportReply {
    const size = Math.min(limit, this.options.pageSize ?? 2)
    const slice = this.log.slice(from, from + size)
    const next = from + slice.length
    return json(200, { entries: slice, cursor: `cur:${next}`, has_more: next < this.log.length })
  }

  private metadata(path: string): TransportReply {
    const entry = this.lookup(path)
    if (!entry) return json(409, { error_summary: 'path/not_found/', error: { '.tag': 'path' } })
    return json(200, strip(entry))
  }

  private download(headers: Record<string, string>): TransportReply {
    const arg = JSON.parse(headers['dropbox-api-arg'] ?? '{}') as { path?: string }
    const entry = this.lookup(arg.path ?? '')
    if (!entry) return json(409, { error_summary: 'path/not_found/', error: { '.tag': 'path' } })
    if (entry.is_downloadable === false) {
      return json(409, { error_summary: 'path/not_file/', error: { '.tag': 'path' } })
    }
    return {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'dropbox-api-result': JSON.stringify(strip(entry)),
      },
      body: Readable.from([Buffer.from(entry.content, 'utf8')]),
    }
  }

  private upload(headers: Record<string, string>, body: string): TransportReply {
    const arg = JSON.parse(headers['dropbox-api-arg'] ?? '{}') as { path?: string }
    const path = arg.path ?? '/untitled'
    const id = `id:upload${++this.counter}`
    this.put({ id, path, content: body })
    return json(200, strip(this.files.get(id)!))
  }

  private lookup(path: string): (Entry & { content: string }) | undefined {
    if (path.startsWith('id:')) return this.files.get(path)
    const lower = path.toLowerCase()
    return [...this.files.values()].find((entry) => entry.path_lower === lower)
  }
}

interface ListArg {
  path: string
  recursive?: boolean
  limit?: number
  include_deleted?: boolean
}

type TransportReply = { status: number; headers: Record<string, string>; body: Readable }

function reply(status: number, body: string, headers: Record<string, string> = {}): TransportReply {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: Readable.from([Buffer.from(body)]) }
}

function json(status: number, value: unknown): TransportReply {
  return reply(status, JSON.stringify(value))
}

function strip(entry: Entry & { content?: string }): Entry {
  const { content: _content, ...rest } = entry
  return rest
}

async function collect(body: unknown): Promise<string> {
  if (body === undefined) return ''
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  const chunks: Buffer[] = []
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}
