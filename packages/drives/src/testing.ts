import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { DriveCredentialsInvalidError, DriveNotificationInvalidError, DriveRateLimitedError } from './errors.js'
import type {
  DriveAccount,
  DriveAuthorization,
  DriveAuthorizeInput,
  DriveChange,
  DriveContent,
  DriveDelta,
  DriveExchangeInput,
  DriveItem,
  DriveListOptions,
  DriveNotificationInput,
  DriveNotificationResult,
  DrivePage,
  DriveProvider,
  DriveRefreshInput,
  DriveSession,
  DriveTokens,
  DriveUploadInput,
  DriveWatch,
  DriveWatchInput,
} from './provider.js'
import { safeEqual } from './secret-box.js'

/**
 * An in-memory provider that behaves like a real one — including the parts that
 * usually only show up in production.
 *
 * The point is not to have "a stub so the tests compile". It is that every
 * behaviour the engine claims to handle can be *provoked* deterministically:
 * expiring an access token, rotating a refresh token, revoking a grant,
 * rate-limiting a call, paginating, emitting a delta feed, deleting a file,
 * changing a file's content version, and sending a notification with the wrong
 * secret. A behaviour that cannot be provoked here is a behaviour that is not
 * really tested.
 *
 * It follows the same shape as the fakes elsewhere in the framework
 * (`FakeBillingGateway`, `MemoryInAppStore`) and ships on the `./testing`
 * subpath so it never reaches an app's production bundle.
 */

export interface FakeDriveFile {
  externalId: string
  name: string
  kind?: 'file' | 'folder'
  contentType?: string
  content?: string
  parentId?: string
  path?: string
  version?: string
  createdAt?: number
  updatedAt?: number
  externalUrl?: string
  exportOnly?: boolean
}

export interface FakeDriveProviderOptions {
  name?: string
  allowedHosts?: readonly string[]
  files?: readonly FakeDriveFile[]
  /** Items per page for `list` and `delta`. Default 50. */
  pageSize?: number
  /** Access-token lifetime handed out by `exchange`/`refresh`. Default 1 hour. */
  accessTokenTtlMs?: number
  /** Emit a NEW refresh token on every refresh, the way Microsoft identity does. */
  rotateRefreshTokens?: boolean
  /** Support the delta/change feed. Default true. */
  supportsDelta?: boolean
  /** Support push subscriptions. Default true. */
  supportsWatch?: boolean
  /** Support writing back. Default false, matching most real integrations. */
  supportsUpload?: boolean
  now?: () => number
}

interface FakeState {
  files: Map<string, DriveItem & { content: string }>
  /** Append-only change log; a delta cursor is an index into it. */
  changes: DriveChange[]
}

/**
 * The provider, plus a control surface (`fake.*`) for a test to drive it.
 */
export class FakeDriveProvider implements DriveProvider {
  readonly name: string
  readonly allowedHosts: readonly string[]
  readonly authorization: DriveAuthorization

  private readonly state: FakeState = { files: new Map(), changes: [] }
  private readonly pageSize: number
  private readonly accessTokenTtl: number
  private readonly now: () => number
  private readonly options: FakeDriveProviderOptions

  /** Refresh tokens the fake still considers valid. */
  private readonly validRefreshTokens = new Set<string>()
  /** Access tokens the fake has issued, with their expiry. */
  private readonly issuedAccessTokens = new Map<string, number>()
  private counter = 0

  // ---- test control surface -------------------------------------------
  /** Calls the fake has served, by method — assert on traffic, not just results. */
  readonly calls: Record<string, number> = {}
  /** Every access token the fake has been shown. Proves a refresh actually took effect. */
  readonly seenAccessTokens: string[] = []
  /** Registered subscriptions. */
  readonly watches = new Map<string, { secret: string; expiresAt: number }>()
  /** When set, the next `n` calls fail with a rate-limit error. */
  rateLimitNextCalls = 0
  /** `Retry-After` the fake reports when rate limiting. */
  retryAfterMs: number | undefined
  /** When true, every `refresh` fails terminally — a revoked grant. */
  grantRevoked = false
  /** When true, a call with an expired access token throws instead of being tolerated. */
  enforceTokenExpiry = true
  /** Deliberately fail the next download after this many bytes. */
  failDownloadAfterBytes: number | undefined

  constructor(options: FakeDriveProviderOptions = {}) {
    this.options = options
    this.name = options.name ?? 'fake'
    this.allowedHosts = options.allowedHosts ?? ['fake-drive.test']
    this.pageSize = options.pageSize ?? 50
    this.accessTokenTtl = options.accessTokenTtlMs ?? 60 * 60_000
    this.now = options.now ?? Date.now
    for (const file of options.files ?? []) this.put(file)
    // Seeded files are the baseline, not "changes" — a first delta sync should
    // see them, so the change log starts populated.
    this.state.changes = [...this.state.files.values()].map((item) => ({ type: 'upserted', item: strip(item) }))

    // A capability the fake does not support must be ABSENT, not throwing: the
    // engine decides what to do by probing for the method (`provider.delta !==
    // undefined`), exactly as it does with a real adapter. An own property
    // shadows the prototype method.
    if (options.supportsDelta === false) this.disable('startDelta', 'delta')
    if (options.supportsWatch === false) this.disable('watch', 'unwatch')
    if (options.supportsUpload !== true) this.disable('upload')

    this.authorization = {
      authorizeUrl: (input: DriveAuthorizeInput) => {
        this.count('authorizeUrl')
        const url = new URL(`https://${this.allowedHosts[0]}/oauth/authorize`)
        url.searchParams.set('state', input.state)
        url.searchParams.set('redirect_uri', input.redirectUri)
        url.searchParams.set('code_challenge', input.codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        if (input.scopes) url.searchParams.set('scope', input.scopes.join(' '))
        return url.toString()
      },
      exchange: async (input: DriveExchangeInput) => {
        this.count('exchange')
        if (input.code === 'bad-code') throw new Error('invalid_grant')
        return this.issue({ refreshToken: this.mint('refresh') })
      },
      refresh: async (input: DriveRefreshInput) => {
        this.count('refresh')
        if (this.grantRevoked || !this.validRefreshTokens.has(input.refreshToken)) {
          throw new DriveCredentialsInvalidError('fake', 'invalid_grant')
        }
        if (this.options.rotateRefreshTokens) {
          // Rotation: the old token dies the moment a new one is issued, which
          // is what makes a stale concurrent writer fatal in the real world.
          this.validRefreshTokens.delete(input.refreshToken)
          return this.issue({ refreshToken: this.mint('refresh') })
        }
        return this.issue({})
      },
      revoke: async () => {
        this.count('revoke')
        this.grantRevoked = true
        this.validRefreshTokens.clear()
      },
      account: async (): Promise<DriveAccount> => {
        this.count('account')
        return { id: 'fake-account', email: 'drive@example.test', name: 'Fake Account' }
      },
    }
  }

  // ---- control helpers -------------------------------------------------

  /**
   * Hides an optional capability by shadowing the prototype method with an own
   * `undefined` property, so `provider.delta !== undefined` is false — the same
   * probe the engine runs against a real adapter.
   */
  private disable(...methods: (keyof DriveProvider)[]): void {
    for (const method of methods) (this as unknown as Record<string, unknown>)[method] = undefined
  }

  /** Adds or replaces a file and records the change (so a delta sync sees it). */
  put(file: FakeDriveFile): DriveItem {
    const content = file.content ?? `content of ${file.name}`
    const existing = this.state.files.get(file.externalId)
    const item: DriveItem & { content: string } = {
      externalId: file.externalId,
      name: file.name,
      kind: file.kind ?? 'file',
      content,
      contentType: file.contentType ?? 'text/plain',
      size: Buffer.byteLength(content),
      version: file.version ?? `r${(existing ? Number(existing.version?.slice(1) ?? 0) : 0) + 1}`,
      checksum: { algorithm: 'sha256', value: sha256Hex(content) },
      createdAt: file.createdAt ?? existing?.createdAt ?? this.now(),
      updatedAt: file.updatedAt ?? this.now(),
      ...(file.parentId !== undefined ? { parentId: file.parentId } : {}),
      ...(file.path !== undefined ? { path: file.path } : {}),
      ...(file.externalUrl !== undefined ? { externalUrl: file.externalUrl } : {}),
      ...(file.exportOnly !== undefined ? { exportOnly: file.exportOnly } : {}),
    }
    this.state.files.set(item.externalId, item)
    // Every write is a change — creating a file is exactly the event a delta
    // sync exists to deliver. The constructor rebuilds the log after seeding,
    // so the initial files are not double-counted.
    this.state.changes.push({ type: 'upserted', item: strip(item) })
    return strip(item)
  }

  /** Changes a file's content, bumping its version — the "this needs re-importing" case. */
  edit(externalId: string, content: string): DriveItem {
    const current = this.state.files.get(externalId)
    if (!current) throw new Error(`fake drive has no file "${externalId}"`)
    return this.put({
      externalId,
      name: current.name,
      content,
      ...(current.contentType !== undefined ? { contentType: current.contentType } : {}),
      version: `r${Number(current.version?.slice(1) ?? 0) + 1}`,
    })
  }

  /** Deletes a file and records the removal. */
  remove(externalId: string): void {
    this.state.files.delete(externalId)
    this.state.changes.push({ type: 'removed', externalId })
  }

  /** Expires every access token issued so far, forcing a refresh on the next call. */
  expireAccessTokens(): void {
    for (const token of this.issuedAccessTokens.keys()) this.issuedAccessTokens.set(token, 0)
  }

  private count(method: string): void {
    this.calls[method] = (this.calls[method] ?? 0) + 1
  }

  private mint(kind: string): string {
    this.counter++
    const token = `${kind}-${this.counter}`
    if (kind === 'refresh') this.validRefreshTokens.add(token)
    return token
  }

  private issue(extra: { refreshToken?: string }): DriveTokens {
    const accessToken = this.mint('access')
    const expiresAt = this.now() + this.accessTokenTtl
    this.issuedAccessTokens.set(accessToken, expiresAt)
    return { accessToken, expiresAt, ...(extra.refreshToken !== undefined ? { refreshToken: extra.refreshToken } : {}) }
  }

  /** Every provider method runs this first: it is what makes the fake's auth real. */
  private check(session: DriveSession, method: string): void {
    this.count(method)
    this.seenAccessTokens.push(session.accessToken)
    if (this.rateLimitNextCalls > 0) {
      this.rateLimitNextCalls--
      throw new DriveRateLimitedError(this.retryAfterMs, this.name)
    }
    if (!this.enforceTokenExpiry) return
    const expiry = this.issuedAccessTokens.get(session.accessToken)
    if (expiry === undefined || expiry <= this.now()) {
      throw new DriveCredentialsInvalidError(session.connectionId, 'the access token is not valid.')
    }
  }

  // ---- DriveProvider ---------------------------------------------------

  async list(session: DriveSession, options: DriveListOptions): Promise<DrivePage<DriveItem>> {
    this.check(session, 'list')
    const all = [...this.state.files.values()]
      .filter((item) => (options.folderId === undefined ? true : item.parentId === options.folderId))
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
    const start = options.cursor === undefined ? 0 : Number(options.cursor)
    const size = options.limit ?? this.pageSize
    const page = all.slice(start, start + size)
    const next = start + size < all.length ? String(start + size) : undefined
    return { items: page.map(strip), ...(next !== undefined ? { cursor: next } : {}) }
  }

  async get(session: DriveSession, externalId: string): Promise<DriveItem | null> {
    this.check(session, 'get')
    const found = this.state.files.get(externalId)
    return found ? strip(found) : null
  }

  async download(session: DriveSession, item: DriveItem): Promise<DriveContent> {
    this.check(session, 'download')
    const found = this.state.files.get(item.externalId)
    if (!found) throw new Error(`fake drive has no file "${item.externalId}"`)
    if (found.exportOnly === true) throw new Error(`"${found.name}" needs to be exported, not downloaded.`)
    const bytes = Buffer.from(found.content, 'utf8')
    const failAfter = this.failDownloadAfterBytes
    const stream =
      failAfter === undefined
        ? Readable.from([bytes])
        : new Readable({
            read() {
              this.push(bytes.subarray(0, failAfter))
              this.destroy(new Error('fake download failed mid-stream'))
            },
          })
    return { stream, contentType: found.contentType, size: bytes.length }
  }

  async upload(session: DriveSession, input: DriveUploadInput): Promise<DriveItem> {
    this.check(session, 'upload')
    if (this.options.supportsUpload !== true) throw new Error('upload is disabled on this fake')
    const chunks: Buffer[] = []
    for await (const chunk of input.content) chunks.push(Buffer.from(chunk as Buffer))
    return this.put({
      externalId: `uploaded-${++this.counter}`,
      name: input.name,
      contentType: input.contentType,
      content: Buffer.concat(chunks).toString('utf8'),
      ...(input.folderId !== undefined ? { parentId: input.folderId } : {}),
    })
  }

  async startDelta(session: DriveSession): Promise<string> {
    this.check(session, 'startDelta')
    if (this.options.supportsDelta === false) throw new Error('delta is disabled on this fake')
    // Cursor 0 = "from the beginning", so a first sync sees the seeded files.
    return '0'
  }

  async delta(session: DriveSession, cursor: string): Promise<DriveDelta> {
    this.check(session, 'delta')
    if (this.options.supportsDelta === false) throw new Error('delta is disabled on this fake')
    const from = Number(cursor)
    const slice = this.state.changes.slice(from, from + this.pageSize)
    const next = from + slice.length
    return { changes: slice, cursor: String(next), hasMore: next < this.state.changes.length }
  }

  async watch(session: DriveSession, input: DriveWatchInput): Promise<DriveWatch> {
    this.check(session, 'watch')
    if (this.options.supportsWatch === false) throw new Error('watch is disabled on this fake')
    const id = `channel-${++this.counter}`
    const expiresAt = this.now() + (input.ttlMs ?? 24 * 60 * 60_000)
    this.watches.set(id, { secret: input.secret, expiresAt })
    return { id, expiresAt }
  }

  async unwatch(session: DriveSession, watch: DriveWatch): Promise<void> {
    this.check(session, 'unwatch')
    this.watches.delete(watch.id)
  }

  /**
   * Models the two real shapes at once: a handshake echo (Microsoft/Dropbox)
   * and a secret-carrying ping (Google/Microsoft).
   */
  verifyNotification(input: DriveNotificationInput): DriveNotificationResult {
    this.count('verifyNotification')
    const challenge = input.query['challenge']
    if (challenge !== undefined) return { challenge, changed: false }

    const secret = input.headers['x-fake-channel-token']
    const watchId = input.headers['x-fake-channel-id']
    if (secret === undefined) throw new DriveNotificationInvalidError('no channel token.')
    // Only accept a token that matches a subscription this fake issued —
    // otherwise a test would "pass" against a provider that authenticates
    // nothing, which is the bug this whole path exists to prevent.
    const known = [...this.watches.values()].some((entry) => safeEqual(entry.secret, secret))
    if (!known) throw new DriveNotificationInvalidError('unknown channel token.')
    return {
      secret,
      changed: input.headers['x-fake-resource-state'] !== 'sync',
      ...(watchId !== undefined ? { watchId } : {}),
    }
  }

  /** Builds a well-formed notification for a registered subscription. */
  notificationFor(watchId: string, options: { state?: string; messageNumber?: number } = {}): DriveNotificationInput {
    const watch = this.watches.get(watchId)
    if (!watch) throw new Error(`fake drive has no subscription "${watchId}"`)
    return {
      method: 'POST',
      headers: {
        'x-fake-channel-id': watchId,
        'x-fake-channel-token': watch.secret,
        'x-fake-resource-state': options.state ?? 'update',
        ...(options.messageNumber !== undefined ? { 'x-goog-message-number': String(options.messageNumber) } : {}),
      },
      query: {},
      body: Buffer.from('{}'),
    }
  }
}

/** Drops the fake's private `content` field before an item crosses the contract. */
function strip(item: DriveItem & { content?: string }): DriveItem {
  const { content: _content, ...rest } = item
  return rest
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
