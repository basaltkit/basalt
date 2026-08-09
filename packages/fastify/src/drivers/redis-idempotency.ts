import type { IdempotencyRecord, IdempotencyStore } from '../idempotency.js'

/** Minimal ioredis-compatible surface — inject your client, no hard dependency. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
}

// A completed record is always JSON of an object (starts with '{'), so this bare
// word can never collide with a serialized record.
const PENDING = 'pending'

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
    private readonly redis: RedisLike,
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

  async get(key: string): Promise<IdempotencyRecord | 'pending' | undefined> {
    const raw = await this.redis.get(this.key(key))
    if (raw === null) return undefined
    if (raw === PENDING) return 'pending'
    return JSON.parse(raw) as IdempotencyRecord
  }

  async setPending(key: string): Promise<void> {
    await this.redis.set(this.key(key), PENDING, 'PX', this.px())
  }

  async complete(key: string, record: IdempotencyRecord): Promise<void> {
    await this.redis.set(this.key(key), JSON.stringify(record), 'PX', this.px())
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.key(key))
  }
}
