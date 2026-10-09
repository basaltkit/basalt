import type { IdempotencyPending, IdempotencyRecord, IdempotencyStore } from '../idempotency.js'

/** Minimal ioredis-compatible surface the idempotency store needs — inject your client, no hard dependency. */
export interface RedisIdempotencyClient {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
}

// A completed record is always JSON of an object (starts with '{'), so these
// bare words can never collide with a serialized record. A reservation that
// carries a request fingerprint is stored as `pending:<fingerprint>`.
const PENDING = 'pending'
const PENDING_WITH = 'pending:'

export interface RedisIdempotencyStoreOptions {
  /** Key prefix. Default: 'basalt:idem'. */
  prefix?: string
  /** Retention window in ms (Redis PX). Default 24h. */
  ttlMs?: number
}

/**
 * Redis-backed `IdempotencyStore` — a first response is cached and replayed for
 * repeats with the same key across every instance, and the reservation survives
 * a restart. Inject an ioredis-compatible client:
 *
 * ```ts
 * import Redis from 'ioredis'
 * idempotencyPlugin({ store: new RedisIdempotencyStore(new Redis(url)) })
 * ```
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly prefix: string
  private readonly ttlMs: number

  constructor(
    private readonly redis: RedisIdempotencyClient,
    options: RedisIdempotencyStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'basalt:idem'
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`
  }

  private px(): number {
    return Math.max(1, Math.ceil(this.ttlMs))
  }

  async get(key: string): Promise<IdempotencyRecord | IdempotencyPending | 'pending' | undefined> {
    const raw = await this.redis.get(this.key(key))
    if (raw === null) return undefined
    if (raw === PENDING) return 'pending'
    if (raw.startsWith(PENDING_WITH)) return { pending: true, fingerprint: raw.slice(PENDING_WITH.length) }
    return JSON.parse(raw) as IdempotencyRecord
  }

  async setPending(key: string, info?: { fingerprint?: string }): Promise<boolean> {
    // SET ... NX makes the reservation atomic: Redis writes the key only if it is
    // absent, returning 'OK'; a losing racer gets null. This closes the TOCTOU gap
    // where two concurrent first-time requests could both reserve and both run.
    const value = info?.fingerprint !== undefined ? `${PENDING_WITH}${info.fingerprint}` : PENDING
    const result = await this.redis.set(this.key(key), value, 'PX', this.px(), 'NX')
    return result !== null
  }

  async complete(key: string, record: IdempotencyRecord): Promise<void> {
    await this.redis.set(this.key(key), JSON.stringify(record), 'PX', this.px())
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.key(key))
  }
}
