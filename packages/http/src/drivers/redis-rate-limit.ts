import type { RateLimitResult, RateLimitStore } from '../security.js'

/** Minimal ioredis-compatible surface — inject your client, no hard dependency. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
}

/**
 * Fixed-window counter, incremented atomically in one round trip. INCR + a
 * first-hit PEXPIRE means concurrent callers across every instance share one
 * count and can't overshoot the limit — the fix for the memory store being
 * per-process and reset on restart.
 *
 * KEYS[1] = window key · ARGV[1] = windowMs
 * returns {count, ttlMs}
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
else
  ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
end
return {count, ttl}
`.trim()

export interface RedisRateLimitStoreOptions {
  /** Key prefix. Default: 'mach:ratelimit'. */
  prefix?: string
  now?: () => number
}

/**
 * Redis-backed `RateLimitStore` — share one rate limit across every instance,
 * surviving restarts. Inject an ioredis-compatible client:
 *
 * ```ts
 * import Redis from 'ioredis'
 * securityPlugin({ rateLimit: { limit: 100, windowMs: 60_000, store: new RedisRateLimitStore(new Redis(url)) } })
 * ```
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string
  private readonly now: () => number

  constructor(
    private readonly redis: RedisLike,
    options: RedisRateLimitStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'mach:ratelimit'
    this.now = options.now ?? (() => Date.now())
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const reply = (await this.redis.eval(HIT_SCRIPT, 1, this.key(key), windowMs)) as [number, number]
    const count = Number(reply[0])
    const remainingMs = Math.max(0, Number(reply[1]))
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: this.now() + remainingMs,
      retryAfterMs: remainingMs,
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.key(key))
  }
}
