import type { CacheDriver } from '@basaltkit/cache'

export interface TieredCacheOptions {
  /**
   * Cache layers ordered fastest → slowest, e.g. `[memory, redis]`. A read
   * checks each in turn; a hit backfills the faster layers it skipped.
   */
  layers: CacheDriver[]
  /**
   * Upper bound (ms) on how long the NEAR layers keep an entry. Applied when
   * backfilling a faster layer from a slower hit (the remaining TTL isn't known
   * there) AND as a clamp on direct writes to every layer except the last — so
   * after another replica updates or deletes a key, no replica serves its local
   * copy for longer than this bound. There is no cross-replica invalidation
   * bus; this bound IS the coherence contract. Default 60000 (1 minute).
   * Set `null` for no bound (single-replica deployments only).
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
    // Clamp the near layers to the staleness bound: an entry written here with
    // its full TTL would keep serving on THIS replica long after another
    // replica updated or deleted it (there is no invalidation bus). The last
    // (shared) layer keeps the caller's TTL — it is the source of truth.
    await Promise.all(
      this.layers.map((layer, index) =>
        layer.set(key, value, index < this.layers.length - 1 ? this.clamp(ttlMs) : ttlMs, tags),
      ),
    )
  }

  private clamp(ttlMs: number | undefined): number | undefined {
    if (this.backfillTtlMs === undefined) return ttlMs
    return ttlMs === undefined ? this.backfillTtlMs : Math.min(ttlMs, this.backfillTtlMs)
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
