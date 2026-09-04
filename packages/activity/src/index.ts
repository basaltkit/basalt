import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import type { BasaltHooks } from '@basaltkit/core'
import { requireTenantId } from '@basaltkit/tenancy'

export interface ActivityRecord {
  readonly id: string
  /** Named log — groups related activity ('default' unless set). */
  readonly log: string
  readonly description: string
  readonly subjectType?: string | undefined
  readonly subjectId?: string | undefined
  /** Who did it — defaults to ctx().user at log time. */
  readonly causerId?: string | undefined
  readonly tenantId?: string | undefined
  readonly properties?: Record<string, unknown> | undefined
  readonly at: number
}

export interface ActivityQuery {
  log?: string
  subjectType?: string
  subjectId?: string
  causerId?: string
  tenantId?: string
  limit?: number
}

export interface ActivityStore {
  append(record: ActivityRecord): Promise<void>
  query(query: ActivityQuery): Promise<ActivityRecord[]>
}

export class MemoryActivityStore implements ActivityStore {
  private readonly records: ActivityRecord[] = []

  async append(record: ActivityRecord): Promise<void> {
    this.records.push(Object.freeze({ ...record }))
  }

  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    const results = this.records
      .filter(
        (record) =>
          (query.log === undefined || record.log === query.log) &&
          (query.subjectType === undefined || record.subjectType === query.subjectType) &&
          (query.subjectId === undefined || record.subjectId === query.subjectId) &&
          (query.causerId === undefined || record.causerId === query.causerId) &&
          (query.tenantId === undefined || record.tenantId === query.tenantId),
      )
      .reverse() // newest first
    return query.limit !== undefined ? results.slice(0, query.limit) : results
  }
}

/**
 * Fluent builder:
 *
 * await activity.in('project')
 *   .performedOn('project', project.id)
 *   .withProperties({ from: 'draft', to: 'published' })
 *   .log('published')
 */
export class ActivityBuilder {
  private subjectType: string | undefined
  private subjectId: string | undefined
  private causerId: string | undefined
  private properties: Record<string, unknown> | undefined

  constructor(
    private readonly store: ActivityStore,
    private readonly logName: string,
  ) {}

  performedOn(type: string, id: string): this {
    this.subjectType = type
    this.subjectId = id
    return this
  }

  /** Overrides the causer (defaults to ctx().user.id). */
  causedBy(userId: string): this {
    this.causerId = userId
    return this
  }

  withProperties(properties: Record<string, unknown>): this {
    this.properties = properties
    return this
  }

  async log(description: string): Promise<ActivityRecord> {
    const context = tryCtx()
    const user = context?.['user'] as { id?: string } | undefined
    const tenant = context?.['tenant'] as { id?: string } | undefined
    const record: ActivityRecord = Object.freeze({
      id: randomUUID(),
      log: this.logName,
      description,
      subjectType: this.subjectType,
      subjectId: this.subjectId,
      causerId: this.causerId ?? user?.id,
      tenantId: tenant?.id,
      properties: this.properties,
      at: Date.now(),
    })
    await this.store.append(record)
    return record
  }
}

/**
 * Records a feed line from a domain event.
 *
 * The same shape `@basaltkit/search` uses for `syncRule` and
 * `@basaltkit/realtime` for `bridgeRule`, and for the same reason: **the domain
 * emits, this package listens, and neither knows the other.** Without it the
 * natural answer to "record this" is to call `activity` from inside the
 * service, which couples the domain to the package the other two teach you to
 * keep at arm's length.
 */
export interface ActivityRule<K extends keyof BasaltHooks & string = keyof BasaltHooks & string> {
  hook: K
  /** Which log the line belongs to. Default: `'default'`. */
  log?: string
  /** What the line is about. */
  subject?: (payload: BasaltHooks[K]) => { type: string; id: string } | null
  /** The line itself. Return null to record nothing for this event. */
  description: (payload: BasaltHooks[K]) => string | null
  /** Structured detail alongside the prose. */
  properties?: (payload: BasaltHooks[K]) => Record<string, unknown> | undefined
  /** Who did it. Defaults to `ctx().user.id`. */
  causer?: (payload: BasaltHooks[K]) => string | undefined
}

/** Type-checks a rule against its hook, then erases the generic. */
export function activityRule<K extends keyof BasaltHooks & string>(
  rule: ActivityRule<K>,
): ActivityRule {
  return rule as unknown as ActivityRule
}

export interface ActivityOptions {
  store?: ActivityStore
  /**
   * Scope queries to ctx().tenant automatically. Default: true.
   *
   * - `true` (default): auto-scope when a tenant is in context; with NO tenant
   *   in context the query runs unscoped (fail-open, historical behavior).
   * - `'required'`: fail-closed via @basaltkit/tenancy's `requireTenantId` —
   *   the context tenant always wins (a caller-supplied `query.tenantId`
   *   cannot widen the scope), an explicit `query.tenantId` is honoured when
   *   no tenant is in context, and otherwise the query THROWS
   *   `TenantRequiredError` instead of silently returning every tenant's
   *   records. Recommended for tenant-facing apps.
   * - `false`: never auto-scope.
   */
  tenantScoped?: boolean | 'required'
  /** Rules turning domain events into feed lines. */
  rules?: ActivityRule[]
  /**
   * Called when a rule throws. Default: a warning on the console.
   *
   * A rule never rethrows. `HookBus` propagates to the emitter, which is right
   * for an audit trail — a fact you failed to record must not be reported as
   * recorded — and wrong for a readable feed: a history line that cannot be
   * written must not fail the case closure that produced it.
   */
  onRuleError?: (error: unknown, rule: ActivityRule) => void
}

export class Activity {
  private readonly store: ActivityStore
  private readonly tenantScoped: boolean | 'required'

  constructor(options: ActivityOptions = {}) {
    this.store = options.store ?? new MemoryActivityStore()
    this.tenantScoped = options.tenantScoped ?? true
  }

  /** Starts a builder in a named log. */
  in(logName: string): ActivityBuilder {
    return new ActivityBuilder(this.store, logName)
  }

  /** Shortcut on the default log. */
  performedOn(type: string, id: string): ActivityBuilder {
    return this.in('default').performedOn(type, id)
  }

  /** Feed of a subject, newest first. */
  async for(type: string, id: string, limit = 20): Promise<ActivityRecord[]> {
    return this.query({ subjectType: type, subjectId: id, limit })
  }

  async inLog(logName: string, limit = 20): Promise<ActivityRecord[]> {
    return this.query({ log: logName, limit })
  }

  async byCauser(userId: string, limit = 20): Promise<ActivityRecord[]> {
    return this.query({ causerId: userId, limit })
  }

  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    if (this.tenantScoped === 'required') {
      // Fail-closed reference usage of @basaltkit/tenancy's helper: context
      // tenant wins, explicit query.tenantId is a fallback, no tenant at all
      // throws TenantRequiredError instead of querying unscoped.
      return this.store.query({ ...query, tenantId: requireTenantId(query.tenantId) })
    }
    const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
    const scoped =
      this.tenantScoped && query.tenantId === undefined && tenant?.id !== undefined
        ? { ...query, tenantId: tenant.id }
        : query
    return this.store.query(scoped)
  }
}

export const ACTIVITY = createToken<Activity>('activity')

export function activityPlugin(options: ActivityOptions = {}) {
  return definePlugin({
    name: 'basalt:activity',
    register({ container }) {
      container.singleton(ACTIVITY, () => {
        // Fail closed by default in multi-tenant apps, the same way
        // `@basaltkit/cache` does and for the same reason. `tenantScoped: true`
        // scopes to the context tenant and runs UNSCOPED when there is none —
        // so a feed query made outside a tenant answered with every tenant's
        // records. An activity line is not an aggregate: it reads "Dr. Kiala
        // opened matter 2026/014 for Kwanza Lda", which is another firm's
        // client, by name, in prose.
        //
        // Tightened only when `@basaltkit/tenancy` is registered (its
        // 'tenancy:active' marker) and only when the app expressed no
        // preference. A single-tenant app has no tenant dimension and nothing
        // to cross, so it is untouched; an app that means to read across
        // tenants says `tenantScoped: false` and is obeyed.
        const tenancyActive = ensureMetadata(container).get('tenancy:active').length > 0
        const resolved: ActivityOptions =
          options.tenantScoped === undefined && tenancyActive
            ? { ...options, tenantScoped: 'required' }
            : options
        return new Activity(resolved)
      })
    },
    boot({ container, hooks }) {
      const rules = options.rules ?? []
      if (rules.length === 0) return
      const activity = container.get(ACTIVITY)
      const onError =
        options.onRuleError ??
        ((error: unknown, rule: ActivityRule) =>
          console.warn(
            `[basalt:activity] rule for "${rule.hook}" failed: ` +
              `${String((error as { message?: string })?.message ?? error)} — the feed line was not written.`,
          ))

      for (const rule of rules) {
        hooks.on(rule.hook, async (payload) => {
          try {
            const description = rule.description(payload)
            if (description === null) return
            let builder = activity.in(rule.log ?? 'default')
            const subject = rule.subject?.(payload)
            if (subject) builder = builder.performedOn(subject.type, subject.id)
            const causer = rule.causer?.(payload)
            if (causer !== undefined) builder = builder.causedBy(causer)
            const properties = rule.properties?.(payload)
            if (properties !== undefined) builder = builder.withProperties(properties)
            await builder.log(description)
          } catch (error) {
            // Swallowed on purpose — see `onRuleError`.
            onError(error, rule)
          }
        })
      }
    },
  })
}
