import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@machize/core'

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

export interface ActivityOptions {
  store?: ActivityStore
  /** Scope queries to ctx().tenant automatically. Default: true. */
  tenantScoped?: boolean
}

export class Activity {
  private readonly store: ActivityStore
  private readonly tenantScoped: boolean

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
    name: 'machize:activity',
    register({ container }) {
      container.singleton(ACTIVITY, () => new Activity(options))
    },
  })
}
