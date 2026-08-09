import { createHash } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@basaltkit/core'

/** Evaluation context. Falls back to the current request's tenant/user. */
export type FlagContext = { tenantId?: string; userId?: string } & Record<string, unknown>

export interface FlagDefinition<T> {
  /** Value when nothing else matches. */
  default: T
  /** Explicit per-tenant overrides, keyed by tenant id. */
  tenants?: Record<string, T>
  /** Explicit per-user overrides, keyed by user id. */
  users?: Record<string, T>
  /**
   * Percentage rollout (0–100) for boolean flags. Deterministic per subject
   * (user id, else tenant id), so a given subject always sees the same result.
   */
  rollout?: number
  /** Custom rule — return a value to override, or `undefined` to fall through. */
  rule?: (context: FlagContext) => T | undefined
}

export type FlagsShape = Record<string, FlagDefinition<unknown>>

/** Value type a flag resolves to. */
export type FlagValue<D> = D extends FlagDefinition<infer T> ? T : never

function contextFromRequest(): FlagContext {
  const current = tryCtx() as { tenant?: { id?: string }; user?: { id?: string } } | undefined
  const context: FlagContext = {}
  if (current?.tenant?.id) context.tenantId = current.tenant.id
  if (current?.user?.id) context.userId = current.user.id
  return context
}

/** Stable 0–99 bucket for a (flag, subject) pair. */
function bucket(flag: string, subject: string): number {
  const hex = createHash('sha1').update(`${flag}:${subject}`).digest('hex').slice(0, 8)
  return parseInt(hex, 16) % 100
}

export class FeatureFlags<TShape extends FlagsShape> {
  constructor(private readonly defs: TShape) {}

  /** Resolves a flag against the given (or current request) context. */
  value<K extends keyof TShape>(key: K, context?: FlagContext): FlagValue<TShape[K]> {
    const def = this.defs[key] as FlagDefinition<unknown>
    const ctx = context ?? contextFromRequest()

    if (def.rule) {
      const ruled = def.rule(ctx)
      if (ruled !== undefined) return ruled as FlagValue<TShape[K]>
    }
    if (ctx.userId && def.users && ctx.userId in def.users) {
      return def.users[ctx.userId] as FlagValue<TShape[K]>
    }
    if (ctx.tenantId && def.tenants && ctx.tenantId in def.tenants) {
      return def.tenants[ctx.tenantId] as FlagValue<TShape[K]>
    }
    if (def.rollout !== undefined && typeof def.default === 'boolean') {
      const subject = ctx.userId ?? ctx.tenantId
      if (subject) return (bucket(String(key), subject) < def.rollout) as FlagValue<TShape[K]>
    }
    return def.default as FlagValue<TShape[K]>
  }

  /** True when the flag resolves to `true`. */
  enabled<K extends keyof TShape>(key: K, context?: FlagContext): boolean {
    return this.value(key, context) === true
  }

  /** Resolves every flag — handy for bootstrapping a client. */
  all(context?: FlagContext): { [K in keyof TShape]: FlagValue<TShape[K]> } {
    const ctx = context ?? contextFromRequest()
    const out = {} as { [K in keyof TShape]: FlagValue<TShape[K]> }
    for (const key of Object.keys(this.defs) as (keyof TShape)[]) out[key] = this.value(key, ctx)
    return out
  }
}

export function defineFlags<TShape extends FlagsShape>(defs: TShape): FeatureFlags<TShape> {
  return new FeatureFlags(defs)
}

export const FLAGS = createToken<FeatureFlags<FlagsShape>>('flags')

/** Registers a FeatureFlags instance (or definitions) under the FLAGS token. */
export function flagsPlugin<TShape extends FlagsShape>(flags: FeatureFlags<TShape> | TShape) {
  const instance = flags instanceof FeatureFlags ? flags : new FeatureFlags(flags)
  return definePlugin({
    name: 'basalt:flags',
    register({ container }) {
      container.singleton(FLAGS, () => instance as FeatureFlags<FlagsShape>)
    },
  })
}
