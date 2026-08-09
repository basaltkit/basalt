import { createToken, definePlugin, BasaltError } from '@basaltkit/core'

export class ConfigKeyError extends BasaltError {
  constructor(path: string) {
    super('CONFIG_KEY_MISSING', `Missing configuration key: "${path}" (no fallback defined).`)
  }
}

/**
 * Packages type their namespaces via module augmentation:
 *
 * declare module '@basaltkit/config' {
 *   interface BasaltConfig {
 *     mail: { from: string }
 *   }
 * }
 */
export interface BasaltConfig {
  [namespace: string]: unknown
}

const MISSING = Symbol('missing')

export class ConfigRepository {
  constructor(private readonly values: Record<string, unknown> = {}) {}

  /** Dot-path access: `config.get('mail.from')`. Throws if missing and no fallback. */
  get<T = unknown>(path: string, fallback?: T): T {
    const value = resolvePath(this.values, path)
    if (value !== MISSING) return value as T
    if (arguments.length >= 2) return fallback as T
    throw new ConfigKeyError(path)
  }

  has(path: string): boolean {
    return resolvePath(this.values, path) !== MISSING
  }

  set(path: string, value: unknown): void {
    const segments = path.split('.')
    let target = this.values
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment]
      if (typeof next !== 'object' || next === null) {
        target[segment] = {}
      }
      target = target[segment] as Record<string, unknown>
    }
    target[segments.at(-1) as string] = value
  }

  /** Merges values on top of the current ones (deep merge of plain objects). */
  merge(values: Record<string, unknown>): void {
    deepMerge(this.values, values)
  }

  all(): Readonly<Record<string, unknown>> {
    return this.values
  }
}

function resolvePath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      return MISSING
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      deepMerge(existing, value)
    } else {
      target[key] = value
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const CONFIG = createToken<ConfigRepository>('config')

export function configPlugin(values: Record<string, unknown> = {}) {
  return definePlugin({
    name: 'basalt:config',
    register({ container }) {
      container.singleton(CONFIG, () => new ConfigRepository(structuredClone(values)))
    },
  })
}
