import { createHash } from 'node:crypto'
import { definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { HttpError } from './errors.js'
import type { BasaltRoute, HttpReply, HttpRequest } from './route.js'
import { isSseResponse } from './sse.js'
import { isStreamResponse } from './stream.js'
import { rawBodyOptionsOf } from './raw-body.js'
import { uploadOptionsOf } from './upload.js'

/**
 * Headers that carry caller credentials. Every one present is folded into the
 * replay scope, so a cached response can only be replayed to a caller presenting
 * the exact same credential material (bearer token, session id, session cookie
 * or API key). By default the check runs before route guards, so this is what
 * keeps a stranger who guesses an Idempotency-Key from receiving someone else's
 * response.
 */
export const DEFAULT_IDEMPOTENCY_CREDENTIAL_HEADERS = ['authorization', 'x-session-id', 'cookie', 'x-api-key'] as const

/** Headers that select the tenant; folded into the scope so replays never cross tenants. */
const TENANT_HEADERS = ['x-tenant-id', 'host'] as const

/** Longest accepted Idempotency-Key (matches the IETF draft / common provider limits). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255

/** A completed outcome, replayed to repeats of the same key. */
export interface IdempotencyRecord {
  status: number
  body: string
  contentType?: string
  /**
   * Hash of the request that produced this record (see the `fingerprint`
   * option). A repeat whose fingerprint differs is refused with `422`.
   * Absent on records written without fingerprinting — those never mismatch.
   */
  fingerprint?: string
}

/** An in-flight reservation that knows the fingerprint of the request holding it. */
export interface IdempotencyPending {
  pending: true
  fingerprint?: string
}

/**
 * Persists idempotency outcomes. Default in-memory; swap `RedisIdempotencyStore`
 * to share replays across instances. Methods may be sync or async — the stage
 * awaits them — so the in-process store stays synchronous while a Redis one doesn't.
 */
export interface IdempotencyStore {
  /**
   * A completed record; for an in-flight request either the string `'pending'`
   * or an {@link IdempotencyPending} carrying the fingerprint given to
   * `setPending`; `undefined` when the key is free. A store that ignores
   * fingerprints may keep returning `'pending'`: a concurrent repeat is then
   * answered `409` rather than `422`.
   */
  get(
    key: string,
  ): IdempotencyRecord | IdempotencyPending | 'pending' | undefined | Promise<IdempotencyRecord | IdempotencyPending | 'pending' | undefined>
  /**
   * Atomically reserve the key iff it is free. Returns `true` when this caller
   * won the reservation, `false` when a record (pending or completed) already
   * exists — the caller must then `get()` to decide replay vs. conflict. The
   * check-and-set MUST be atomic so two concurrent first-time requests can't
   * both win (Redis `SET NX`, a single synchronous step in-process). `info`
   * carries the request fingerprint to keep on the reservation, when
   * fingerprinting is on.
   */
  setPending(key: string, info?: { fingerprint?: string }): boolean | Promise<boolean>
  complete(key: string, record: IdempotencyRecord): void | Promise<void>
  /** Release a reservation so the client can retry (e.g. after a 5xx). */
  release(key: string): void | Promise<void>
}

export interface MemoryIdempotencyStoreOptions {
  /**
   * Upper bound on retained entries. When full, expired entries are swept and
   * then the oldest entries are evicted. Default 10_000.
   */
  maxEntries?: number
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { record?: IdempotencyRecord; fingerprint?: string; expiresAt: number }>()
  private readonly maxEntries: number
  private readonly sweepIntervalMs: number
  private lastSweep: number

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly clock: () => number = () => Date.now(),
    options: MemoryIdempotencyStoreOptions = {},
  ) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000))
    this.sweepIntervalMs = Math.max(1, Math.min(ttlMs, 60_000))
    this.lastSweep = clock()
  }

  /** Number of retained entries (expired ones may linger until the next sweep). */
  get size(): number {
    return this.entries.size
  }

  private sweep(now: number): void {
    this.lastSweep = now
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key)
    }
  }

  /** Lazily drop expired entries and enforce the maxEntries cap before inserting. */
  private makeRoom(): void {
    const now = this.clock()
    if (now - this.lastSweep >= this.sweepIntervalMs || this.entries.size >= this.maxEntries) this.sweep(now)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get(key: string): IdempotencyRecord | IdempotencyPending | 'pending' | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.clock() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    if (entry.record) return entry.record
    return entry.fingerprint !== undefined ? { pending: true, fingerprint: entry.fingerprint } : 'pending'
  }

  setPending(key: string, info?: { fingerprint?: string }): boolean {
    const entry = this.entries.get(key)
    if (entry) {
      if (this.clock() < entry.expiresAt) return false // already reserved or completed
      this.entries.delete(key) // expired — free to reclaim
    }
    this.makeRoom()
    this.entries.set(key, {
      expiresAt: this.clock() + this.ttlMs,
      ...(info?.fingerprint !== undefined ? { fingerprint: info.fingerprint } : {}),
    })
    return true
  }

  complete(key: string, record: IdempotencyRecord): void {
    if (!this.entries.has(key)) this.makeRoom()
    this.entries.set(key, { record, expiresAt: this.clock() + this.ttlMs })
  }

  release(key: string): void {
    this.entries.delete(key)
  }
}

/** What a custom `fingerprint` function receives. */
export interface IdempotencyFingerprintInput {
  route: BasaltRoute
  request: HttpRequest
}

export interface IdempotencyPluginOptions {
  store?: IdempotencyStore
  /** Request header carrying the key. Default 'idempotency-key'. */
  header?: string
  /** Methods to guard. Default ['POST']. */
  methods?: string[]
  /** Retention window in ms of the default in-memory store. Default 24h. */
  ttlMs?: number
  /**
   * Request headers carrying caller credentials; every one present is folded
   * into the replay scope. Default: `authorization`, `x-session-id`, `cookie`,
   * `x-api-key`. Add your custom auth/API-key header here if you use one.
   */
  credentialHeaders?: string[]
  /**
   * Also cache and replay requests that carry none of the credential headers.
   * Default `false`: anonymous callers share no identity to scope a replay by,
   * so any stranger knowing the key would receive the cached response.
   */
  allowAnonymous?: boolean
  /**
   * Binds a key to the request it was first used with. A repeat of the key
   * whose fingerprint differs — a different body under the same key, a
   * client bug that would otherwise silently receive the FIRST request's
   * result — is refused with `422 IDEMPOTENCY_KEY_REUSED`, also while the
   * first request is still in flight.
   *
   * - `'body'`: a SHA-256 of the body — canonical JSON (keys sorted) of the
   *   parsed body, or the exact bytes of a `rawBody()` route. `upload()`
   *   routes are not fingerprinted by `'body'` (their stream is read by the
   *   handler); give them a function.
   * - a function: your own fingerprint (e.g. over a header and the body); its
   *   result is hashed. Return `undefined` to skip fingerprinting a request.
   * - `false` (default): keys are not bound to a body (the pre-existing
   *   behaviour; a future major will default to `'body'`).
   */
  fingerprint?: 'body' | false | ((input: IdempotencyFingerprintInput) => string | undefined)
  /**
   * Run the check after the route's enrichers, guards and request validation,
   * just before the handler, instead of before the guards. A caller whose
   * credentials were revoked then gets the guard's `401`/`403` instead of the
   * cached success, and a request that fails validation is never reserved.
   * Default `false` (the pre-existing order; a future major will default to
   * `true`).
   */
  replayAfterGuards?: boolean
}

/** Metadata bucket holding the registered idempotency stage. Read by the route pipeline. */
const IDEMPOTENCY_BUCKET = 'http:idempotency'

const headerValue = (request: HttpRequest, name: string): string => {
  const raw = request.headers[name]
  if (raw === undefined) return ''
  return Array.isArray(raw) ? raw.join('\n') : String(raw)
}

/** Length-prefixed encoding of the caller's credential headers, or '' when anonymous. */
function principalOf(request: HttpRequest, credentialHeaders: readonly string[]): string {
  let out = ''
  for (const name of credentialHeaders) {
    const value = headerValue(request, name)
    if (value) out += `${name}:${value.length}:${value};`
  }
  return out
}

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` fingerprint alike. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return ''
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k]
      return sorted
    }
    return v
  })
}

const sha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex')

/** The reservation a request holds while its handler runs. */
export interface IdempotencyTicket {
  readonly scoped: string
  readonly fingerprint: string | undefined
}

/** A reply that remembers what the handler sent through it, to record it afterwards. */
export class RecordingReply implements HttpReply {
  payload: unknown
  sentHere = false
  contentType: string | undefined

  constructor(private readonly inner: HttpReply) {}

  get sent(): boolean {
    return this.inner.sent
  }
  get statusCode(): number {
    return this.inner.statusCode
  }
  get raw(): unknown {
    return this.inner.raw
  }
  code(status: number): this {
    this.inner.code(status)
    return this
  }
  header(name: string, value: string): this {
    if (name.toLowerCase() === 'content-type') this.contentType = value
    this.inner.header(name, value)
    return this
  }
  send(payload?: unknown): this {
    this.sentHere = true
    this.payload = payload
    this.inner.send(payload)
    return this
  }
}

/** `undefined` for a payload that is not replayable as a stored string (bytes, streams, …). */
function serialise(payload: unknown, contentType: string | undefined): { body: string; contentType?: string } | undefined {
  if (payload === undefined || payload === null) return { body: '', ...(contentType ? { contentType } : {}) }
  if (typeof payload === 'string') return { body: payload, contentType: contentType ?? 'text/plain; charset=utf-8' }
  if (isStreamResponse(payload) || isSseResponse(payload)) return undefined
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) return undefined
  if (typeof payload !== 'object') return { body: JSON.stringify(payload), contentType: contentType ?? 'application/json; charset=utf-8' }
  const p = payload as { pipe?: unknown; getReader?: unknown; then?: unknown }
  if (typeof p.pipe === 'function' || typeof p.getReader === 'function' || typeof p.then === 'function') return undefined
  return { body: JSON.stringify(payload), contentType: contentType ?? 'application/json; charset=utf-8' }
}

/**
 * The framework-neutral idempotency stage. Registered by
 * {@link idempotencyPlugin}; the route pipeline (`runRoute`) drives it, so it
 * behaves the same on every adapter. Not constructed directly by apps.
 */
export class IdempotencyStage {
  readonly store: IdempotencyStore
  private readonly header: string
  private readonly methods: ReadonlySet<string>
  private readonly credentialHeaders: readonly string[]
  private readonly allowAnonymous: boolean
  private readonly fingerprintMode: IdempotencyPluginOptions['fingerprint']
  readonly replayAfterGuards: boolean

  constructor(options: IdempotencyPluginOptions = {}) {
    const fp = options.fingerprint
    if (fp !== undefined && fp !== false && fp !== 'body' && typeof fp !== 'function') {
      throw new TypeError(`idempotencyPlugin: fingerprint must be 'body', false or a function (got ${String(fp)})`)
    }
    this.store = options.store ?? new MemoryIdempotencyStore(options.ttlMs)
    this.header = (options.header ?? 'idempotency-key').toLowerCase()
    this.methods = new Set((options.methods ?? ['POST']).map((method) => method.toUpperCase()))
    this.credentialHeaders = (options.credentialHeaders ?? [...DEFAULT_IDEMPOTENCY_CREDENTIAL_HEADERS]).map((name) => name.toLowerCase())
    this.allowAnonymous = options.allowAnonymous === true
    this.fingerprintMode = fp
    this.replayAfterGuards = options.replayAfterGuards === true
  }

  /**
   * Where the check runs for this route: `'beforeGuards'`, `'beforeHandler'`
   * or `undefined` (the request is not subject to idempotency). A `rawBody()`
   * route fingerprinted by `'body'` is always checked before the handler: its
   * bytes are never read before the guards have passed.
   */
  placement(route: BasaltRoute, request: HttpRequest): 'beforeGuards' | 'beforeHandler' | undefined {
    if (!this.methods.has(request.method.toUpperCase())) return undefined
    const raw = request.headers[this.header]
    const key = Array.isArray(raw) ? raw[0] : raw
    if (!key) return undefined
    if (this.replayAfterGuards) return 'beforeHandler'
    if (this.fingerprintMode === 'body' && rawBodyOptionsOf(route.body)) return 'beforeHandler'
    return 'beforeGuards'
  }

  private fingerprintOf(route: BasaltRoute, request: HttpRequest, rawBytes: Uint8Array | undefined): string | undefined {
    const mode = this.fingerprintMode
    if (!mode) return undefined
    if (typeof mode === 'function') {
      const value = mode({ route, request })
      return value === undefined ? undefined : sha256(String(value))
    }
    if (uploadOptionsOf(route.body)) return undefined
    if (rawBodyOptionsOf(route.body)) return rawBytes === undefined ? undefined : sha256(rawBytes)
    return sha256(canonicalJson(request.body))
  }

  /**
   * Reserves the key, or answers for the handler: a replay of the completed
   * record (returns `'replayed'`), `409` while it is in flight, `422` for a
   * different request under the same key, `400` for an over-long key. Returns
   * the ticket to settle after the handler, or `undefined` when the request is
   * not subject to idempotency (no key, anonymous without opt-in).
   */
  async begin(
    route: BasaltRoute,
    request: HttpRequest,
    reply: HttpReply,
    rawBytes?: Uint8Array,
  ): Promise<IdempotencyTicket | 'replayed' | undefined> {
    const raw = request.headers[this.header]
    const key = Array.isArray(raw) ? raw[0] : raw
    if (!key) return undefined
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`)
    }
    // Scope by the caller's full credential material and tenant so an
    // Idempotency-Key can never replay one user's cached response to another.
    // Before the guards an anonymous request has no identity to scope by: skip
    // it unless explicitly allowed. (The scope is the one the Fastify-only
    // plugin used, so records it stored keep replaying.)
    const principal = principalOf(request, this.credentialHeaders)
    if (!principal && !this.allowAnonymous) return undefined
    const tenant = TENANT_HEADERS.map((name) => headerValue(request, name))
    const scoped = sha256(JSON.stringify([principal || 'anon', tenant, request.method, route.url, key]))
    const fingerprint = this.fingerprintOf(route, request, rawBytes)

    // Reserve atomically first: a plain get()-then-setPending has a TOCTOU
    // window where two concurrent first-time requests both read undefined and
    // both execute the handler — the double-charge this stage exists to stop.
    if (await this.store.setPending(scoped, fingerprint !== undefined ? { fingerprint } : undefined)) {
      return { scoped, fingerprint }
    }

    // Someone got there first: replay, conflict or a reused key.
    const existing = await this.store.get(scoped)
    const mismatch = (stored: string | undefined): boolean =>
      fingerprint !== undefined && stored !== undefined && stored !== fingerprint
    if (existing && existing !== 'pending' && !('pending' in existing)) {
      if (mismatch(existing.fingerprint)) throw reused()
      if (existing.contentType) reply.header('content-type', existing.contentType)
      reply.header('idempotent-replayed', 'true')
      reply.code(existing.status).send(existing.body === '' ? undefined : existing.body)
      return 'replayed'
    }
    if (existing && existing !== 'pending' && mismatch(existing.fingerprint)) throw reused()
    // Still in flight (or vanished mid-race) → conflict; the client can retry.
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is already in progress.')
  }

  /** Records the handler's outcome (or releases the key when it is not replayable). */
  async complete(ticket: IdempotencyTicket, reply: RecordingReply, result: unknown): Promise<void> {
    const status = reply.statusCode
    let serialised: ReturnType<typeof serialise>
    try {
      serialised = status >= 500 ? undefined : serialise(reply.sentHere ? reply.payload : result, reply.contentType)
    } catch {
      // Not JSON-serialisable (a BigInt, a cycle): the adapter fails to send it
      // too. Release rather than leave the key pending, or every retry would
      // get 409 until the reservation expires.
      serialised = undefined
    }
    if (!serialised) {
      await this.store.release(ticket.scoped) // keep failures (and streams) retryable
      return
    }
    await this.store.complete(ticket.scoped, {
      status,
      ...serialised,
      ...(ticket.fingerprint !== undefined ? { fingerprint: ticket.fingerprint } : {}),
    })
  }

  /**
   * Settles a ticket whose route threw. A client error (`< 500`) is recorded as
   * the response the adapter is about to send; anything else releases the key.
   * Never throws: the route's own error is what the client must see.
   */
  async fail(ticket: IdempotencyTicket, response: { status: number; body: unknown }): Promise<void> {
    try {
      if (response.status >= 500) {
        await this.store.release(ticket.scoped)
        return
      }
      await this.store.complete(ticket.scoped, {
        status: response.status,
        body: JSON.stringify(response.body),
        contentType: 'application/json; charset=utf-8',
        ...(ticket.fingerprint !== undefined ? { fingerprint: ticket.fingerprint } : {}),
      })
    } catch {
      // A store failure here must not mask the route's error.
    }
  }
}

const reused = (): HttpError =>
  new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.')

const stages = new WeakMap<Container, IdempotencyStage | null>()

/** The idempotency stage registered on `container`, if any (cached per container). */
export function idempotencyStageOf(container: Container | undefined): IdempotencyStage | undefined {
  if (!container) return undefined
  let stage = stages.get(container)
  if (stage === undefined) {
    stage = ensureMetadata(container).get<IdempotencyStage>(IDEMPOTENCY_BUCKET)[0] ?? null
    stages.set(container, stage)
  }
  return stage ?? undefined
}

/**
 * Safe retries for mutating requests, on every adapter: when a client sends an
 * `Idempotency-Key`, the first response is cached and replayed for any repeat
 * with the same key — so a network retry never charges a card or creates a
 * duplicate twice.
 *
 * - A repeat while the first is still in flight → `409 IDEMPOTENCY_CONFLICT`.
 * - With `fingerprint`, a repeat carrying a different request →
 *   `422 IDEMPOTENCY_KEY_REUSED` (in flight or completed).
 * - Responses `>= 500`, streams and event streams are not cached, so genuine
 *   failures stay retryable.
 * - Keys are scoped by caller credentials (`credentialHeaders`), tenant
 *   (`x-tenant-id`, `host`), method and route, and stored as a SHA-256 hash.
 * - Requests without credentials are not cached unless `allowAnonymous: true`.
 * - Keys longer than 255 characters → `400 IDEMPOTENCY_KEY_INVALID`.
 * - By default the check runs before the route guards; `replayAfterGuards`
 *   moves it after them.
 *
 * It covers the routes Basalt serves (`route()` definitions on any adapter),
 * not handlers registered on the underlying framework by hand.
 */
export function idempotencyPlugin(options: IdempotencyPluginOptions = {}) {
  const stage = new IdempotencyStage(options)
  return definePlugin({
    name: 'basalt:idempotency',
    register({ container }) {
      ensureMetadata(container).add(IDEMPOTENCY_BUCKET, stage)
    },
  })
}
