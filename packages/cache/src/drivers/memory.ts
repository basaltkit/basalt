import type { CacheDriver } from '../driver.js'

interface Entry {
  value: unknown
  expiresAt?: number
  tags: Set<string>
}

export class MemoryCacheDriver implements CacheDriver {
  private readonly store = new Map<string, Entry>()

  async get(key: string): Promise<unknown> {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: string, value: unknown, ttlMs?: number, tags: string[] = []): Promise<void> {
    this.store.set(key, {
      value,
      ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      tags: new Set(tags),
    })
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
}
