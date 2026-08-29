import {
  BasaltError,
  createToken,
  definePlugin,
  ensureMetadata,
  parseDuration,
  tryCtx,
  type DurationInput,
} from '@basaltkit/core'
import type { CacheDriver } from './driver.js'
import { MemoryCacheDriver } from './drivers/memory.js'
import { RedisCacheDriver } from './drivers/redis.js'

export type { CacheDriver } from './driver.js'
export { MemoryCacheDriver } from './drivers/memory.js'
export { RedisCacheDriver } from './drivers/redis.js'

export class MissingCacheScopeError extends BasaltError {
  constructor(op: string) {
    super(
      'CACHE_SCOPE_MISSING',
      `Refusing cache ${op}: a tenant-scoped cache resolved no tenant (ran without a tenant context). Establish a tenant, or use scope:null for a deliberate global cache.`,
    )
  }
}

export interface CacheOptions {
  /** Root prefix for all keys. Default: 'basalt' */
  prefix?: string
  /**
   * Dynamic segment of the prefix, resolved on every operation. The default reads
   * `ctx().tenant.id` — automatic per-tenant isolation. Pass `null` to disable
   * (a deliberate global cache).
   */
  scope?: (() => string | undefined) | null
  /**
   * What to do when the scope function resolves nothing (no tenant in context):
   * `'global'` (default) shares one namespace — convenient but a per-tenant value
   * cached without a tenant leaks to others; `'error'` fails closed (throws
   * {@link MissingCacheScopeError}) on read/write. `flush()` ALWAYS fails closed
   * regardless, so a mis-scoped call can't wipe every tenant's cache.
   */
  onMissingScope?: 'global' | 'error'
  /** Injectable clock (ms) for stale-while-revalidate windows. Default: Date.now. */
  now?: () => number
}

/** SwrOptions turns `remember` into a stale-while-revalidate read. */
export interface SwrOptions {
  /** How long the value stays fresh (served without revalidation). */
  ttl: DurationInput
  /**
   * Extra window after `ttl` during which a stale value is served immediately
   * while a single background revalidation refreshes it. After `ttl + staleFor`
   * the entry is hard-expired and the next read blocks on the factory.
   */
  staleFor: DurationInput
}

/** Internal wrapper stored for SWR entries; carries the freshness windows. */
interface SwrEnvelope {
  __swr: 1
  v: unknown
  freshUntil: number
  staleUntil: number
}

function isEnvelope(value: unknown): value is SwrEnvelope {
  return typeof value === 'object' && value !== null && (value as { __swr?: unknown }).__swr === 1
}

function isSwr(value: DurationInput | SwrOptions): value is SwrOptions {
  return typeof value === 'object' && value !== null && 'staleFor' in value
}

const defaultScope = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ? `tenant:${tenant.id}` : undefined
}

export class Cache {
  private readonly prefix: string
  private readonly scope: (() => string | undefined) | null
  private readonly onMissingScope: 'global' | 'error'
  private readonly now: () => number
  /** dedupe of in-flight factories — per-process stampede protection (also dedupes SWR revalidation) */
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly driver: CacheDriver,
    options: CacheOptions = {},
  ) {
    this.prefix = options.prefix ?? 'basalt'
    this.scope = options.scope === undefined ? defaultScope : options.scope
    this.onMissingScope = options.onMissingScope ?? 'global'
    this.now = options.now ?? Date.now
  }

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(key: string, fallback: T): Promise<T>
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    const stored = await this.driver.get(this.key(key))
    const value = isEnvelope(stored) ? stored.v : stored
    return value === undefined ? fallback : (value as T)
  }

  async put(key: string, value: unknown, ttl?: DurationInput): Promise<void> {
    await this.driver.set(
      this.key(key),
      value,
      ttl === undefined ? undefined : parseDuration(ttl),
    )
  }

  /**
   * One-line cache-aside, with stampede protection: concurrent calls
   * for the same key share ONE execution of the factory.
   */
  async remember<T>(key: string, ttl: DurationInput, factory: () => Promise<T> | T): Promise<T>
  async remember<T>(key: string, options: SwrOptions, factory: () => Promise<T> | T): Promise<T>
  async remember<T>(
    key: string,
    ttlOrOptions: DurationInput | SwrOptions,
    factory: () => Promise<T> | T,
  ): Promise<T> {
    return this.rememberWithTags(key, ttlOrOptions, factory, [])
  }

  async forget(key: string): Promise<boolean> {
    return this.driver.delete(this.key(key))
  }

  /** Clears only the keys under this prefix/scope — never the entire Redis. */
  async flush(): Promise<void> {
    // Always fail closed: a whole-namespace wipe with an unresolved tenant scope
    // would delete EVERY tenant's cache. `scope:null` (deliberate global) is fine.
    if (this.scope !== null && this.scope() === undefined) throw new MissingCacheScopeError('flush')
    await this.driver.flushPrefix(this.root())
  }

  /** Tag-scoped operations: `cache.tags('plans').flush()` invalidates the group. */
  tags(...tags: string[]) {
    const scopedTags = tags.map((tag) => `${this.root()}${tag}`)
    return {
      put: async (key: string, value: unknown, ttl?: DurationInput): Promise<void> => {
        await this.driver.set(
          this.key(key),
          value,
          ttl === undefined ? undefined : parseDuration(ttl),
          scopedTags,
        )
      },
      remember: <T>(
        key: string,
        ttlOrOptions: DurationInput | SwrOptions,
        factory: () => Promise<T> | T,
      ): Promise<T> => this.rememberWithTags(key, ttlOrOptions, factory, scopedTags),
      flush: async (): Promise<void> => {
        await this.driver.flushTags(scopedTags)
      },
    }
  }

  private async rememberWithTags<T>(
    key: string,
    ttlOrOptions: DurationInput | SwrOptions,
    factory: () => Promise<T> | T,
    tags: string[],
  ): Promise<T> {
    const fullKey = this.key(key)
    const stored = await this.driver.get(fullKey)

    // Plain hard-TTL remember (no staleFor): unchanged cache-aside with raw values.
    if (!isSwr(ttlOrOptions)) {
      const cached = isEnvelope(stored) ? stored.v : stored
      if (cached !== undefined) return cached as T
      return this.compute(fullKey, () => factory(), (value) =>
        this.driver.set(fullKey, value, parseDuration(ttlOrOptions), tags),
      )
    }

    // Stale-while-revalidate path.
    const ttlMs = parseDuration(ttlOrOptions.ttl)
    const staleMs = parseDuration(ttlOrOptions.staleFor)
    const store = (value: T): Promise<void> => {
      const now = this.now()
      const envelope: SwrEnvelope = {
        __swr: 1,
        v: value,
        freshUntil: now + ttlMs,
        staleUntil: now + ttlMs + staleMs,
      }
      // Driver TTL is the hard window; Cache-layer windows gate fresh/stale/expired.
      return this.driver.set(fullKey, envelope, ttlMs + staleMs, tags)
    }

    if (isEnvelope(stored)) {
      const now = this.now()
      if (now < stored.freshUntil) return stored.v as T
      if (now < stored.staleUntil) {
        // Serve stale immediately; refresh once in the background.
        this.revalidate(fullKey, () => factory(), store)
        return stored.v as T
      }
      // Hard-expired → fall through to a blocking recompute.
    } else if (stored !== undefined) {
      // A raw value written by put()/plain remember(): treat as fresh, no windows.
      return stored as T
    }

    return this.compute(fullKey, () => factory(), store)
  }

  /** Blocking cache-aside compute with per-key stampede dedupe. */
  private compute<T>(
    fullKey: string,
    factory: () => Promise<T> | T,
    store: (value: T) => Promise<void>,
  ): Promise<T> {
    const inFlight = this.pending.get(fullKey)
    if (inFlight) return inFlight as Promise<T>
    const computation = (async () => {
      try {
        const value = await factory()
        await store(value)
        return value
      } finally {
        this.pending.delete(fullKey)
      }
    })()
    this.pending.set(fullKey, computation)
    return computation
  }

  /** Fire-and-forget SWR refresh: one per key, failures keep serving stale. */
  private revalidate<T>(
    fullKey: string,
    factory: () => Promise<T> | T,
    store: (value: T) => Promise<void>,
  ): void {
    if (this.pending.has(fullKey)) return
    const computation = (async () => {
      try {
        const value = await factory()
        await store(value)
      } finally {
        this.pending.delete(fullKey)
      }
    })()
    this.pending.set(fullKey, computation)
    // Never surface a background error as an unhandled rejection.
    void computation.catch(() => undefined)
  }

  private root(): string {
    if (this.scope === null) return `${this.prefix}:` // deliberate global cache
    const scope = this.scope()
    if (scope === undefined && this.onMissingScope === 'error') throw new MissingCacheScopeError('operation')
    return scope ? `${this.prefix}:${scope}:` : `${this.prefix}:`
  }

  private key(key: string): string {
    return this.root() + key
  }
}

export const CACHE = createToken<Cache>('cache')

export interface CachePluginOptions extends CacheOptions {
  /** 'memory' (default), 'redis' (needs `url`), or a custom `CacheDriver` instance. */
  driver?: 'memory' | 'redis' | CacheDriver
  /** Required with the 'redis' driver. */
  url?: string
}

export function cachePlugin(options: CachePluginOptions = {}) {
  let driver: CacheDriver | undefined
  return definePlugin({
    name: 'basalt:cache',
    register({ container }) {
      container.singleton(CACHE, () => {
        driver =
          typeof options.driver === 'object'
            ? options.driver
            : options.driver === 'redis'
              ? RedisCacheDriver.fromUrl(options.url as string)
              : new MemoryCacheDriver()
        // Fail closed by default in multi-tenant apps: when @basaltkit/tenancy
        // is registered (its 'tenancy:active' metadata marker), an operation
        // with no resolvable tenant scope throws instead of silently sharing
        // one global namespace across tenants. Single-tenant apps (no tenancy)
        // are untouched, and an explicit `onMissingScope`/custom `scope` wins.
        const tenancyActive = ensureMetadata(container).get('tenancy:active').length > 0
        const resolved: CacheOptions =
          options.onMissingScope === undefined && options.scope === undefined && tenancyActive
            ? { ...options, onMissingScope: 'error' }
            : options
        return new Cache(driver, resolved)
      })
    },
    async shutdown() {
      await driver?.disconnect()
    },
  })
}
