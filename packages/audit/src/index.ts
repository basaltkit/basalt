import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'

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

/** Object keys whose values are masked before an entry is persisted. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|credential|cookie|session|otp|mfa/i

/** Recursively masks sensitive fields so secrets/PII never reach the trail. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactSensitive(v, depth + 1)
  }
  return out
}

export type AuditRedactor = (payload: unknown, event: string) => unknown

/** Default payload scrubber: masks common secret keys, ignoring the event name. */
export const defaultAuditRedactor: AuditRedactor = (payload) => redactSensitive(payload)

export class Audit {
  constructor(
    private readonly store: AuditStore,
    /** Scrubs each payload before it is stored. Default masks common secret keys. */
    private readonly redact: AuditRedactor = defaultAuditRedactor,
  ) {}

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
    // Auto-scope to the current tenant when one is in context (and the query
    // didn't pin one), so a tenant-facing caller forwarding a client query can't
    // read another tenant's trail. A system caller outside a tenant context can
    // still query broadly.
    const tenantId = query.tenantId ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    return this.store.query(tenantId !== undefined ? { ...query, tenantId } : query)
  }

  private build(source: AuditEntry['source'], event: string, payload: unknown): AuditEntry {
    const context = tryCtx()
    const user = context?.['user'] as { id?: string } | undefined
    const tenant = context?.['tenant'] as { id?: string } | undefined
    return Object.freeze({
      id: randomUUID(),
      source,
      event,
      payload: this.redact(payload, event),
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
  /**
   * Scrubs each payload before it is stored. Defaults to masking common secret
   * keys (password, token, secret, authorization, api-key, …). Pass a custom
   * function to change the policy, or `(p) => p` to store payloads verbatim.
   */
  redact?: AuditRedactor
}

const DEFAULT_HOOK_PATTERNS = ['auth:**', 'billing:**', 'tenancy:**', 'permission:**']

export function auditPlugin(options: AuditPluginOptions = {}) {
  const hookPatterns = options.hooks ?? DEFAULT_HOOK_PATTERNS
  const eventPatterns = options.events ?? ['**']

  return definePlugin({
    name: 'basalt:audit',
    register({ container, hooks }) {
      container.singleton(AUDIT, () => new Audit(options.store ?? new MemoryAuditStore(), options.redact ?? defaultAuditRedactor))

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
