import { createHash } from 'node:crypto'
import { definePlugin } from '@basaltkit/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FASTIFY } from './adapter.js'

/**
 * Headers that carry caller credentials. Every one present is folded into the
 * replay scope, so a cached response can only be replayed to a caller presenting
 * the exact same credential material (bearer token, session id, session cookie
 * or API key). The replay runs before route guards, so this is what keeps a
 * stranger who guesses an Idempotency-Key from receiving someone else's response.
 */
export const DEFAULT_IDEMPOTENCY_CREDENTIAL_HEADERS = ['authorization', 'x-session-id', 'cookie', 'x-api-key'] as const

/** Headers that select the tenant; folded into the scope so replays never cross tenants. */
const TENANT_HEADERS = ['x-tenant-id', 'host'] as const

/** Longest accepted Idempotency-Key (matches the IETF draft / common provider limits). */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255

function headerValue(request: FastifyRequest, name: string): string {
  const raw = request.headers[name]
  if (raw === undefined) return ''
  return Array.isArray(raw) ? raw.join('\n') : String(raw)
}

/**
 * Length-prefixed encoding of the caller's credential headers, or '' when the
 * request carries none (anonymous).
 */
function principalOf(request: FastifyRequest, credentialHeaders: readonly string[]): string {
  let out = ''
  for (const name of credentialHeaders) {
    const value = headerValue(request, name)
    if (value) out += `${name}:${value.length}:${value};`
  }
  return out
}

export interface IdempotencyRecord {
  status: number
  body: string
  contentType?: string
}

/**
 * Persists idempotency outcomes. Default in-memory; swap `RedisIdempotencyStore`
 * to share replays across instances. Methods may be sync or async — the plugin
 * awaits them — so the in-process store stays synchronous while a Redis one doesn't.
 */
export interface IdempotencyStore {
  /** A completed record, the string 'pending' for an in-flight request, or undefined. */
  get(key: string): IdempotencyRecord | 'pending' | undefined | Promise<IdempotencyRecord | 'pending' | undefined>
  /**
   * Atomically reserve the key iff it is free. Returns `true` when this caller
   * won the reservation, `false` when a record (pending or completed) already
   * exists — the caller must then `get()` to decide replay vs. conflict. The
   * check-and-set MUST be atomic so two concurrent first-time requests can't
   * both win (Redis `SET NX`, a single synchronous step in-process).
   */
  setPending(key: string): boolean | Promise<boolean>
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
  private readonly entries = new Map<string, { record?: IdempotencyRecord; expiresAt: number }>()
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

  get(key: string): IdempotencyRecord | 'pending' | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.clock() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry.record ?? 'pending'
  }

  setPending(key: string): boolean {
    const entry = this.entries.get(key)
    if (entry) {
      if (this.clock() < entry.expiresAt) return false // already reserved or completed
      this.entries.delete(key) // expired — free to reclaim
    }
    this.makeRoom()
    this.entries.set(key, { expiresAt: this.clock() + this.ttlMs })
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

export interface IdempotencyPluginOptions {
  store?: IdempotencyStore
  /** Request header carrying the key. Default 'idempotency-key'. */
  header?: string
  /** Methods to guard. Default ['POST']. */
  methods?: string[]
  /** Retention window in ms. Default 24h. */
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
}

const KEY = Symbol('basalt.idempotencyKey')

/**
 * Safe retries for mutating requests: when a client sends an `Idempotency-Key`,
 * the first response is cached and replayed for any repeat with the same key —
 * so a network retry never charges a card or creates a duplicate twice.
 *
 * - A repeat while the first is still in-flight → `409 IDEMPOTENCY_CONFLICT`.
 * - Responses `>= 500` are not cached, so genuine failures stay retryable.
 * - Keys are scoped by caller credentials (`credentialHeaders`), tenant
 *   (`x-tenant-id`, `host`), method and route, and stored as a SHA-256 hash.
 * - Requests without credentials are not cached unless `allowAnonymous: true`.
 * - Keys longer than 255 characters → `400 IDEMPOTENCY_KEY_INVALID`.
 */
export function idempotencyPlugin(options: IdempotencyPluginOptions = {}) {
  const store = options.store ?? new MemoryIdempotencyStore(options.ttlMs)
  const header = (options.header ?? 'idempotency-key').toLowerCase()
  const methods = new Set((options.methods ?? ['POST']).map((method) => method.toUpperCase()))
  const credentialHeaders = (options.credentialHeaders ?? [...DEFAULT_IDEMPOTENCY_CREDENTIAL_HEADERS]).map((name) =>
    name.toLowerCase(),
  )
  const allowAnonymous = options.allowAnonymous === true

  return definePlugin({
    name: 'basalt:idempotency',
    dependsOn: ['basalt:fastify'],
    boot({ container }) {
      const app: FastifyInstance = container.get(FASTIFY)

      app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        if (!methods.has(request.method)) return
        const raw = request.headers[header]
        const key = Array.isArray(raw) ? raw[0] : raw
        if (!key) return
        if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
          return reply.code(400).send({
            error: {
              code: 'IDEMPOTENCY_KEY_INVALID',
              message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
            },
          })
        }

        // Scope by the caller's full credential material and tenant so an
        // Idempotency-Key can never replay one user's cached response to another.
        // This hook runs before route guards, so an anonymous request has no
        // identity to scope by: skip it unless explicitly allowed.
        const principal = principalOf(request, credentialHeaders)
        if (!principal && !allowAnonymous) return
        const tenant = TENANT_HEADERS.map((name) => headerValue(request, name))
        const scoped = createHash('sha256')
          .update(
            JSON.stringify([
              principal || 'anon',
              tenant,
              request.method,
              request.routeOptions?.url ?? request.url,
              key,
            ]),
          )
          .digest('hex')

        // Reserve atomically first: a plain get()-then-setPending has a TOCTOU
        // window where two concurrent first-time requests both read undefined and
        // both execute the handler — the double-charge this plugin exists to stop.
        const reserved = await store.setPending(scoped)
        if (reserved) {
          // Only the reservation owner records the outcome in onSend. A replay or
          // a 409 conflict must never overwrite (or release) the owner's entry.
          ;(request as unknown as Record<symbol, string>)[KEY] = scoped
          return undefined // we won the reservation → run the handler
        }

        // Someone got there first. Read the record to decide replay vs. conflict.
        const existing = await store.get(scoped)
        if (existing && existing !== 'pending') {
          if (existing.contentType) void reply.header('Content-Type', existing.contentType)
          void reply.header('Idempotent-Replayed', 'true')
          return reply.code(existing.status).send(existing.body)
        }
        // Still in flight (or vanished mid-race) → conflict; the client can retry.
        return reply.code(409).send({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'A request with this Idempotency-Key is already in progress.',
          },
        })
      })

      app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        const scoped = (request as unknown as Record<symbol, string>)[KEY]
        if (!scoped) return payload // not the reservation owner (replay, conflict or unguarded)
        if (reply.statusCode >= 500 || typeof payload !== 'string') {
          await store.release(scoped) // keep failures retryable
          return payload
        }
        const contentType = reply.getHeader('Content-Type') as string | undefined
        await store.complete(scoped, {
          status: reply.statusCode,
          body: payload,
          ...(contentType ? { contentType } : {}),
        })
        return payload
      })
    },
  })
}
