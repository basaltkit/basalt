import { Redis } from 'ioredis'
import type { CacheDriver } from '../driver.js'

/**
 * Namespace for tag indexes, outside the value key space. Each tag is a SORTED
 * SET scoring every member by its expiry timestamp (`+inf` for entries with no
 * TTL), which lets expired members be pruned in O(log n) — a plain SET grew
 * forever, since Redis never tells us that a member key has expired.
 *
 * NOTE the namespace changed from the pre-1.x `__tags__:` plain sets. Old sets
 * are inert orphans; clear them once with `DEL __tags__:*` after upgrading.
 */
const TAG_PREFIX = '__tagz__:'
/** Reverse index (key → its tags), so `delete` can unregister the key from its tags. */
const TAGS_OF_PREFIX = '__tagsof__:'

/**
 * Escapes Redis glob metacharacters so a key segment is matched literally.
 * Scope segments carry user-controlled data (a tenant id / slug); left raw, a
 * tenant named `a*` would make `flushPrefix` match — and DELETE — other tenants' keys.
 */
export function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]^]/g, (c) => `\\${c}`)
}

export class RedisCacheDriver implements CacheDriver {
  constructor(private readonly redis: Redis) {}

  static fromUrl(url: string): RedisCacheDriver {
    return new RedisCacheDriver(new Redis(url))
  }

  async get(key: string): Promise<unknown> {
    const raw = await this.redis.get(key)
    return raw === null ? undefined : (JSON.parse(raw) as unknown)
  }

  async set(key: string, value: unknown, ttlMs?: number, tags: string[] = []): Promise<void> {
    const raw = JSON.stringify(value)
    if (ttlMs !== undefined) {
      await this.redis.set(key, raw, 'PX', Math.max(1, Math.ceil(ttlMs)))
    } else {
      await this.redis.set(key, raw)
    }
    if (tags.length === 0) return
    const score = ttlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlMs
    const now = Date.now()
    for (const tag of tags) {
      const tagKey = TAG_PREFIX + tag
      // Drop members that have already expired before adding the new one: the
      // index stays proportional to the LIVE key set instead of growing forever.
      await this.redis.zremrangebyscore(tagKey, '-inf', `(${now}`)
      await this.redis.zadd(tagKey, score === Number.POSITIVE_INFINITY ? '+inf' : String(score), key)
    }
    const reverseKey = TAGS_OF_PREFIX + key
    await this.redis.sadd(reverseKey, ...tags)
    if (ttlMs !== undefined) await this.redis.pexpire(reverseKey, Math.max(1, Math.ceil(ttlMs)))
  }

  async delete(key: string): Promise<boolean> {
    const reverseKey = TAGS_OF_PREFIX + key
    const tags = await this.redis.smembers(reverseKey)
    for (const tag of tags) await this.redis.zrem(TAG_PREFIX + tag, key)
    if (tags.length > 0) await this.redis.del(reverseKey)
    return (await this.redis.del(key)) > 0
  }

  async flushPrefix(prefix: string): Promise<void> {
    const pattern = `${escapeGlob(prefix)}*`
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) await this.redis.del(...keys)
    } while (cursor !== '0')
  }

  async flushTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      const tagKey = TAG_PREFIX + tag
      const keys = await this.redis.zrange(tagKey, '0', '-1')
      if (keys.length > 0) {
        await this.redis.del(...keys)
        await this.redis.del(...keys.map((key) => TAGS_OF_PREFIX + key))
      }
      await this.redis.del(tagKey)
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit()
  }
}
