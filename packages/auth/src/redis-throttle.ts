import type { ThrottleStore, ThrottleWindow } from './throttle.js'

/**
 * The minimal ioredis-compatible surface {@link RedisThrottleStore} needs —
 * inject your client (ioredis, or node-redis behind a two-method adapter); no
 * dependency on any Redis library.
 */
export interface RedisThrottleClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
}

/**
 * INCR + a first-hit PEXPIRE in one script: concurrent attempts on every
 * replica share one count and can never read-then-write past the budget.
 * KEYS[1] = counter · ARGV[1] = windowMs · returns {count, ttlMs}
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

/** KEYS[1] = counter · returns {count, ttlMs} ({0, 0} when absent). */
const PEEK_SCRIPT = `
local count = redis.call('GET', KEYS[1])
if not count then return {0, 0} end
return {tonumber(count), redis.call('PTTL', KEYS[1])}
`.trim()

/** KEYS[1] = counter · decrements, deleting the key once it reaches zero. */
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local count = redis.call('DECR', KEYS[1])
if count <= 0 then redis.call('DEL', KEYS[1]) end
return count
`.trim()

export interface RedisThrottleStoreOptions {
  /** Key prefix. Default: `basalt:throttle`. */
  prefix?: string
}

/**
 * Redis-backed {@link ThrottleStore}: the login, MFA and email-request
 * throttles of every replica share one budget, and a lockout survives a
 * restart. Each operation is one atomic Lua script (fixed window).
 *
 * ```ts
 * import Redis from 'ioredis'
 * authPlugin({ users, secret, throttleStore: new RedisThrottleStore(new Redis(url)) })
 * ```
 */
export class RedisThrottleStore implements ThrottleStore {
  private readonly prefix: string

  constructor(
    private readonly redis: RedisThrottleClient,
    options: RedisThrottleStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'basalt:throttle'
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`
  }

  async hit(key: string, windowMs: number): Promise<ThrottleWindow> {
    const reply = (await this.redis.eval(HIT_SCRIPT, 1, this.key(key), windowMs)) as [number, number]
    return { count: Number(reply[0]), retryAfterMs: Math.max(0, Number(reply[1])) }
  }

  async peek(key: string): Promise<ThrottleWindow | null> {
    const reply = (await this.redis.eval(PEEK_SCRIPT, 1, this.key(key))) as [number, number]
    const count = Number(reply[0])
    return count > 0 ? { count, retryAfterMs: Math.max(0, Number(reply[1])) } : null
  }

  async release(key: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key(key))
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.key(key))
  }
}
