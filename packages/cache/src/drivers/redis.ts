import { Redis } from 'ioredis'
import type { CacheDriver } from '../driver.js'

/** Namespace for tag sets in Redis, outside the value key space. */
const TAG_PREFIX = '__tags__:'

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
    for (const tag of tags) {
      await this.redis.sadd(TAG_PREFIX + tag, key)
    }
  }

  async delete(key: string): Promise<boolean> {
    return (await this.redis.del(key)) > 0
  }

  async flushPrefix(prefix: string): Promise<void> {
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) await this.redis.del(...keys)
    } while (cursor !== '0')
  }

  async flushTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      const tagKey = TAG_PREFIX + tag
      const keys = await this.redis.smembers(tagKey)
      if (keys.length > 0) await this.redis.del(...keys)
      await this.redis.del(tagKey)
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit()
  }
}
