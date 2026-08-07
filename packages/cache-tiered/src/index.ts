import type { CacheDriver } from '@machize/cache'

export interface TieredCacheOptions {
  /**
   * Cache layers ordered fastest → slowest, e.g. `[memory, redis]`. A read
   * checks each in turn; a hit backfills the faster layers it skipped.
   */
  layers: CacheDriver[]
  /**
   * TTL (ms) applied when backfilling a faster layer from a slower hit — the
   * remaining TTL isn't known there, so this bounds how long the near cache
   * keeps it. Default 60000 (1 minute). Set `null` for no expiry.
   */
  backfillTtlMs?: number | null
}

/**
 * A multi-level cache driver: an in-process near cache in front of a shared
 * far cache (Redis) cuts network round-trips for hot keys. It implements the
 * same `CacheDriver` contract by delegating — writes and invalidations fan out
 * to every layer, reads short-circuit on the first hit and backfill the faster
 * layers. No gaps: whatever your layers support (tags, prefix flush), this does.
 */
export class TieredCacheDriver implements CacheDriver {
  private readonly layers: CacheDriver[]
  private readonly backfillTtlMs: number | undefined

  constructor(options: TieredCacheOptions) {
    if (options.layers.length === 0) throw new Error('TieredCacheDriver needs at least one layer.')
    this.layers = options.layers
    this.backfillTtlMs = options.backfillTtlMs === null ? undefined : (options.backfillTtlMs ?? 60_000)
  }

  async get(key: string): Promise<unknown> {
    for (let i = 0; i < this.layers.length; i++) {
      const value = await this.layers[i]!.get(key)
      if (value !== undefined) {
        // Backfill the faster layers that missed.
        for (let j = 0; j < i; j++) await this.layers[j]!.set(key, value, this.backfillTtlMs)
        return value
      }
    }
    return undefined
  }

  async set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.set(key, value, ttlMs, tags)))
  }

  async delete(key: string): Promise<boolean> {
    const results = await Promise.all(this.layers.map((layer) => layer.delete(key)))
    return results.some(Boolean)
  }

  async flushPrefix(prefix: string): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.flushPrefix(prefix)))
  }

  async flushTags(tags: string[]): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.flushTags(tags)))
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.layers.map((layer) => layer.disconnect()))
  }
}
