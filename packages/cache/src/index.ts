import {
  createToken,
  definePlugin,
  parseDuration,
  tryCtx,
  type DurationInput,
} from '@machize/core'
import type { CacheDriver } from './driver.js'
import { MemoryCacheDriver } from './drivers/memory.js'
import { RedisCacheDriver } from './drivers/redis.js'

export type { CacheDriver } from './driver.js'
export { MemoryCacheDriver } from './drivers/memory.js'
export { RedisCacheDriver } from './drivers/redis.js'

export interface CacheOptions {
  /** Prefixo raiz de todas as chaves. Default: 'mach' */
  prefix?: string
  /**
   * Segmento dinâmico do prefixo, resolvido a cada operação. O default lê
   * `ctx().tenant.id` — isolamento por tenant automático. Passe `null` para desligar.
   */
  scope?: (() => string | undefined) | null
}

const defaultScope = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ? `tenant:${tenant.id}` : undefined
}

export class Cache {
  private readonly prefix: string
  private readonly scope: (() => string | undefined) | null
  /** dedupe de factories em voo — stampede protection por processo */
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly driver: CacheDriver,
    options: CacheOptions = {},
  ) {
    this.prefix = options.prefix ?? 'mach'
    this.scope = options.scope === undefined ? defaultScope : options.scope
  }

  async get<T>(key: string): Promise<T | undefined>
  async get<T>(key: string, fallback: T): Promise<T>
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    const value = await this.driver.get(this.key(key))
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
   * Cache-aside em uma linha, com stampede protection: chamadas concorrentes
   * para a mesma chave compartilham UMA execução da factory.
   */
  async remember<T>(key: string, ttl: DurationInput, factory: () => Promise<T> | T): Promise<T> {
    return this.rememberWithTags(key, ttl, factory, [])
  }

  async forget(key: string): Promise<boolean> {
    return this.driver.delete(this.key(key))
  }

  /** Limpa apenas as chaves deste prefixo/escopo — nunca o Redis inteiro. */
  async flush(): Promise<void> {
    await this.driver.flushPrefix(this.root())
  }

  /** Operações associadas a tags: `cache.tags('plans').flush()` invalida o grupo. */
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
      remember: <T>(key: string, ttl: DurationInput, factory: () => Promise<T> | T): Promise<T> =>
        this.rememberWithTags(key, ttl, factory, scopedTags),
      flush: async (): Promise<void> => {
        await this.driver.flushTags(scopedTags)
      },
    }
  }

  private async rememberWithTags<T>(
    key: string,
    ttl: DurationInput,
    factory: () => Promise<T> | T,
    tags: string[],
  ): Promise<T> {
    const fullKey = this.key(key)
    const cached = await this.driver.get(fullKey)
    if (cached !== undefined) return cached as T

    const inFlight = this.pending.get(fullKey)
    if (inFlight) return inFlight as Promise<T>

    const computation = (async () => {
      try {
        const value = await factory()
        await this.driver.set(fullKey, value, parseDuration(ttl), tags)
        return value
      } finally {
        this.pending.delete(fullKey)
      }
    })()
    this.pending.set(fullKey, computation)
    return computation
  }

  private root(): string {
    const scope = this.scope?.()
    return scope ? `${this.prefix}:${scope}:` : `${this.prefix}:`
  }

  private key(key: string): string {
    return this.root() + key
  }
}

export const CACHE = createToken<Cache>('cache')

export interface CachePluginOptions extends CacheOptions {
  driver?: 'memory' | 'redis'
  /** Obrigatório com driver 'redis'. */
  url?: string
}

export function cachePlugin(options: CachePluginOptions = {}) {
  let driver: CacheDriver | undefined
  return definePlugin({
    name: 'machize:cache',
    register({ container }) {
      container.singleton(CACHE, () => {
        driver =
          options.driver === 'redis'
            ? RedisCacheDriver.fromUrl(options.url as string)
            : new MemoryCacheDriver()
        return new Cache(driver, options)
      })
    },
    async shutdown() {
      await driver?.disconnect()
    },
  })
}
