import type { UsageConsumeResult, UsageStore } from '../stores.js'

/** Minimal ioredis-compatible surface — inject your client, no hard dependency. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

/**
 * Check-and-increment in one Redis round trip. EVAL runs atomically on the
 * server, so concurrent callers can never overshoot the limit — the fix for
 * the memory store's check-then-increment race.
 *
 * KEYS[1] = counter key · ARGV = amount, limit, ttlSeconds
 * returns {applied (1/0), usage}
 */
const CONSUME_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if current + amount > limit then
  return {0, current}
end
local total = redis.call('INCRBY', KEYS[1], amount)
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return {1, total}
`.trim()

export interface RedisUsageStoreOptions {
  /** Key prefix. Default: 'basalt:usage'. */
  prefix?: string
  /**
   * TTL in seconds for periodic (monthly) counters, so old buckets are
   * reclaimed. Lifetime counters never expire. Default: 60 days.
   */
  ttlSeconds?: number
}

export class RedisUsageStore implements UsageStore {
  private readonly prefix: string
  private readonly ttlSeconds: number

  constructor(
    private readonly redis: RedisLike,
    options: RedisUsageStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'basalt:usage'
    this.ttlSeconds = options.ttlSeconds ?? 60 * 24 * 60 * 60
  }

  private key(billableId: string, feature: string, periodKey: string): string {
    return `${this.prefix}:${billableId}:${feature}:${periodKey}`
  }

  private ttlFor(periodKey: string): number {
    return periodKey === 'lifetime' ? 0 : this.ttlSeconds
  }

  async get(billableId: string, feature: string, periodKey: string): Promise<number> {
    const raw = await this.redis.get(this.key(billableId, feature, periodKey))
    return raw === null ? 0 : Number(raw)
  }

  async increment(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
  ): Promise<number> {
    // Unlimited path: reuse the script with an effectively-infinite limit.
    const reply = await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      this.key(billableId, feature, periodKey),
      amount,
      Number.MAX_SAFE_INTEGER,
      this.ttlFor(periodKey),
    )
    return Number((reply as [number, number])[1])
  }

  async consume(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
    limit: number,
  ): Promise<UsageConsumeResult> {
    const reply = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      this.key(billableId, feature, periodKey),
      amount,
      limit,
      this.ttlFor(periodKey),
    )) as [number, number]
    return { applied: Number(reply[0]) === 1, used: Number(reply[1]) }
  }
}
