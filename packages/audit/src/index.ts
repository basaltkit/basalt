import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@machize/core'
import { EVENTS } from '@machize/events'

/** One immutable line of the trail. */
export interface AuditEntry {
  readonly id: string
  /** Where it came from: a lifecycle hook, a domain event or a manual record. */
  readonly source: 'hook' | 'event' | 'manual'
  readonly event: string
  readonly payload: unknown
  /** Enriched from the ALS context at record time. */
  readonly actorId?: string | undefined
  readonly tenantId?: string | undefined
  readonly requestId?: string | undefined
  readonly at: number
}

export interface AuditQuery {
  /** Wildcard pattern over the event name (e.g. 'auth:**'). */
  event?: string
  tenantId?: string
  actorId?: string
  since?: number
  limit?: number
}

/** Append-only by contract: no update, no delete. */
export interface AuditStore {
  append(entry: AuditEntry): Promise<void>
  query(query: AuditQuery): Promise<AuditEntry[]>
}

export class MemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = []

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(Object.freeze({ ...entry }))
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    let results = this.entries.filter(
      (entry) =>
        (query.event === undefined || patternMatches(query.event, entry.event)) &&
        (query.tenantId === undefined || entry.tenantId === query.tenantId) &&
        (query.actorId === undefined || entry.actorId === query.actorId) &&
        (query.since === undefined || entry.at >= query.since),
    )
    results = [...results].reverse() // newest first
    return query.limit !== undefined ? results.slice(0, query.limit) : results
  }
}

/**
 * Wildcard matcher over ':' and '.' segments: 'auth:**' matches 'auth:login',
 * 'order.*' matches 'order.created', '**' matches everything.
 */
export function patternMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '**') return true
  const split = (value: string) => value.split(/[.:]/)
  const patternSegments = split(pattern)
  const nameSegments = split(name)
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i]
    if (segment === '**') return i < nameSegments.length
    if (i >= nameSegments.length) return false
    if (segment !== '*' && segment !== nameSegments[i]) return false
  }
  return patternSegments.length === nameSegments.length
}

export class Audit {
  constructor(private readonly store: AuditStore) {}

  /** Manual entry — for actions no hook covers. */
  async record(event: string, payload?: unknown): Promise<AuditEntry> {
    const entry = this.build('manual', event, payload)
    await this.store.append(entry)
    return entry
  }

  /** @internal used by the plugin's hook/event taps. */
  async capture(source: 'hook' | 'event', event: string, payload: unknown): Promise<void> {
    await this.store.append(this.build(source, event, payload))
  }

  async trail(query: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.store.query(query)
  }

  private build(source: AuditEntry['source'], event: string, payload: unknown): AuditEntry {
    const context = tryCtx()
    const user = context?.['user'] as { id?: string } | undefined
    const tenant = context?.['tenant'] as { id?: string } | undefined
    return Object.freeze({
      id: randomUUID(),
      source,
      event,
      payload,
      actorId: user?.id,
      tenantId: tenant?.id,
      requestId: context?.requestId,
      at: Date.now(),
    })
  }
}

export const AUDIT = createToken<Audit>('audit')

export interface AuditPluginOptions {
  store?: AuditStore
  /**
   * Lifecycle hook patterns to record automatically.
   * Default: auth, billing, tenancy and permission activity.
   */
  hooks?: string[]
  /**
   * Domain event patterns recorded from the EventBus (when present).
   * Default: everything. Pass [] to disable.
   */
  events?: string[]
}

const DEFAULT_HOOK_PATTERNS = ['auth:**', 'billing:**', 'tenancy:**', 'permission:**']

export function auditPlugin(options: AuditPluginOptions = {}) {
  const hookPatterns = options.hooks ?? DEFAULT_HOOK_PATTERNS
  const eventPatterns = options.events ?? ['**']

  return definePlugin({
    name: 'machize:audit',
    register({ container, hooks }) {
      container.singleton(AUDIT, () => new Audit(options.store ?? new MemoryAuditStore()))

      hooks.onAny(async (hook, payload) => {
        if (!hookPatterns.some((pattern) => patternMatches(pattern, hook))) return
        await container.get(AUDIT).capture('hook', hook, payload)
      })
    },
    boot({ container }) {
      if (eventPatterns.length === 0 || !container.has(EVENTS)) return
      const bus = container.get(EVENTS)
      bus.on('**', async (payload, meta) => {
        if (!eventPatterns.some((pattern) => patternMatches(pattern, meta.name))) return
        await container.get(AUDIT).capture('event', meta.name, payload)
      })
    },
  })
}
