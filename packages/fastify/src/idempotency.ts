import { createHash } from 'node:crypto'
import { definePlugin } from '@basaltkit/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FASTIFY } from './adapter.js'

/** Short, non-reversible fingerprint of the caller's credential, or '' if anonymous. */
function principalOf(request: FastifyRequest): string {
  const raw = request.headers['authorization'] ?? request.headers['x-session-id'] ?? ''
  const value = Array.isArray(raw) ? (raw[0] ?? '') : raw
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : 'anon'
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
  setPending(key: string): void | Promise<void>
  complete(key: string, record: IdempotencyRecord): void | Promise<void>
  /** Release a reservation so the client can retry (e.g. after a 5xx). */
  release(key: string): void | Promise<void>
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { record?: IdempotencyRecord; expiresAt: number }>()

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get(key: string): IdempotencyRecord | 'pending' | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.clock() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry.record ?? 'pending'
  }

  setPending(key: string): void {
    this.entries.set(key, { expiresAt: this.clock() + this.ttlMs })
  }

  complete(key: string, record: IdempotencyRecord): void {
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
}

const KEY = Symbol('basalt.idempotencyKey')

/**
 * Safe retries for mutating requests: when a client sends an `Idempotency-Key`,
 * the first response is cached and replayed for any repeat with the same key —
 * so a network retry never charges a card or creates a duplicate twice.
 *
 * - A repeat while the first is still in-flight → `409 IDEMPOTENCY_CONFLICT`.
 * - Responses `>= 500` are not cached, so genuine failures stay retryable.
 * - Keys are scoped by method + route so the same key on two endpoints can't collide.
 */
export function idempotencyPlugin(options: IdempotencyPluginOptions = {}) {
  const store = options.store ?? new MemoryIdempotencyStore(options.ttlMs)
  const header = (options.header ?? 'idempotency-key').toLowerCase()
  const methods = new Set((options.methods ?? ['POST']).map((method) => method.toUpperCase()))

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

        // Scope by the caller's credential so an Idempotency-Key can never replay
        // one user's cached response to another (cross-user/tenant data leak).
        const scoped = `${principalOf(request)}:${request.method}:${request.routeOptions?.url ?? request.url}:${key}`
        ;(request as unknown as Record<symbol, string>)[KEY] = scoped

        const existing = await store.get(scoped)
        if (existing === 'pending') {
          return reply.code(409).send({
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'A request with this Idempotency-Key is already in progress.',
            },
          })
        }
        if (existing) {
          if (existing.contentType) void reply.header('Content-Type', existing.contentType)
          void reply.header('Idempotent-Replayed', 'true')
          return reply.code(existing.status).send(existing.body)
        }
        await store.setPending(scoped)
        return undefined
      })

      app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        const scoped = (request as unknown as Record<symbol, string>)[KEY]
        if (!scoped) return payload
        if (reply.getHeader('Idempotent-Replayed')) return payload // this IS a replay
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
