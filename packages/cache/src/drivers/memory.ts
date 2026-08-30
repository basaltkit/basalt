import type { CacheDriver } from '../driver.js'

interface Entry {
  value: unknown
  expiresAt?: number
  tags: Set<string>
}

/**
 * How many entries the in-process driver holds before it starts evicting.
 * It is the DEFAULT driver, so it must be bounded: an unbounded map keyed by
 * user-influenced strings (ids, slugs, query fingerprints) is an OOM vector.
 * Raise it — or pass `maxEntries: Infinity` — if you deliberately want no cap.
 */
const DEFAULT_MAX_ENTRIES = 10_000

export interface MemoryCacheDriverOptions {
  /**
   * Maximum number of live entries. Past it, expired entries are dropped first,
   * then the least-recently-used ones. Default 10 000; `Infinity` disables the cap.
   */
  maxEntries?: number
}

/**
 * Bounded in-process cache with LRU eviction. `get` counts as a use, so hot keys
 * survive; cold ones are evicted first.
 */
export class MemoryCacheDriver implements CacheDriver {
  private readonly store = new Map<string, Entry>()
  private readonly maxEntries: number

  constructor(options: MemoryCacheDriverOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /** Live entry count — useful to assert the bound in tests and diagnostics. */
  get size(): number {
    return this.store.size
  }

  async get(key: string): Promise<unknown> {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (this.expired(entry)) {
      this.store.delete(key)
      return undefined
    }
    // Re-insert to move the key to the most-recently-used end of the Map.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  async set(key: string, value: unknown, ttlMs?: number, tags: string[] = []): Promise<void> {
    this.store.delete(key) // rewrite counts as a use → move to the MRU end
    this.store.set(key, {
      value,
      ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      tags: new Set(tags),
    })
    this.evict()
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  async flushPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }

  async flushTags(tags: string[]): Promise<void> {
    for (const [key, entry] of this.store) {
      if (tags.some((tag) => entry.tags.has(tag))) this.store.delete(key)
    }
  }

  async disconnect(): Promise<void> {
    this.store.clear()
  }

  private expired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && Date.now() >= entry.expiresAt
  }

  /** Reclaim space: expired entries first (free wins), then least-recently-used. */
  private evict(): void {
    if (this.store.size <= this.maxEntries) return
    for (const [key, entry] of this.store) {
      if (this.store.size <= this.maxEntries) return
      if (this.expired(entry)) this.store.delete(key)
    }
    for (const key of this.store.keys()) {
      if (this.store.size <= this.maxEntries) return
      this.store.delete(key)
    }
  }
}
