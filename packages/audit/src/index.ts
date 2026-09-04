import { createHash, randomUUID } from 'node:crypto'
import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
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

/** How deep the redactors walk a payload before dropping the rest. */
const MAX_REDACT_DEPTH = 6
/** Stand-in for a subtree deeper than {@link MAX_REDACT_DEPTH}. */
const TRUNCATED = '[truncated]'

/**
 * The event filter a driver may push into SQL as an equality. A pattern with a
 * wildcard must still be matched in code; so must one containing `.`, because
 * {@link patternMatches} treats `.` and `:` as interchangeable separators and an
 * equality would miss `a:b` for the pattern `a.b`.
 */
export function exactEventMatch(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined
  return /[*.]/.test(pattern) ? undefined : pattern
}

/**
 * Rows a driver reads per round-trip when a wildcard pattern forces a scan.
 * Bounds peak memory: a limited query no longer materialises the whole trail.
 */
export const AUDIT_SCAN_PAGE = 500

/** Object keys whose values are masked before an entry is persisted. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|credential|cookie|session|otp|mfa/i

/** Recursively masks sensitive fields so secrets/PII never reach the trail. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  // Past the depth bound the subtree is dropped, NOT passed through: event
  // payloads are arbitrary, and returning the raw value here let a secret nested
  // deeper than the limit reach the trail in cleartext.
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
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

/** Object keys that commonly carry direct PII and can be pseudonymized on request. */
const PII_KEY = /e[-_]?mail|phone|msisdn|ssn|nif|taxid|passport/i
/** A value that looks like an email address. */
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Deterministically pseudonymizes a value: the same input always maps to the
 * same opaque token, so records stay correlatable without persisting the raw PII.
 */
export function pseudonymize(value: string): string {
  return `pii_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

/**
 * Recursively masks secrets (like {@link redactSensitive}) AND replaces obvious
 * PII — email/phone-shaped values, and values under common PII keys — with a
 * stable pseudonym. Use it to minimize PII at rest in the trail while keeping
 * entries correlatable.
 */
export function redactSensitiveAndPii(value: unknown, depth = 0): unknown {
  if (value === null) return value
  // Bound the length before the regex: a real email is <= 254 chars (RFC 5321),
  // so only test plausibly-email-length strings — arbitrary logged values never
  // reach the regex, avoiding ReDoS on attacker-influenceable input.
  if (typeof value === 'string')
    return value.length <= 320 && EMAIL_VALUE.test(value) ? pseudonymize(value) : value
  if (typeof value !== 'object') return value
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
  if (Array.isArray(value)) return value.map((v) => redactSensitiveAndPii(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]'
    else if (PII_KEY.test(k) && typeof v === 'string') out[k] = pseudonymize(v)
    else out[k] = redactSensitiveAndPii(v, depth + 1)
  }
  return out
}

/**
 * Payload scrubber that also pseudonymizes obvious PII (PII F3). Opt-in — pass it
 * to `auditPlugin({ redact: piiMinimizingRedactor })` or `new Audit(store, piiMinimizingRedactor)`.
 *
 * TODO(PII F3 follow-up): the default capture set still persists whatever the
 * emitting code puts in the payload. A fuller minimization pass would let callers
 * declare per-event field policies; kept out of the default here to avoid changing
 * existing capture/redaction behavior.
 */
export const piiMinimizingRedactor: AuditRedactor = (payload) => redactSensitiveAndPii(payload)

export class Audit {
  constructor(
    private readonly store: AuditStore,
    /** Scrubs each payload before it is stored. Default masks common secret keys. */
    private readonly redact: AuditRedactor = defaultAuditRedactor,
    /**
     * Whether the host app is multi-tenant, i.e. whether `@basaltkit/tenancy`
     * is registered. `auditPlugin` wires this to the container's
     * `'tenancy:active'` metadata marker; it is a *signal*, never an import —
     * `@basaltkit/audit` is a generic package and must not depend on tenancy.
     *
     * Defaults to `false`: a hand-built `new Audit(store)` behaves like a
     * single-tenant app, which is the only thing it can safely assume.
     */
    private readonly tenancyActive: () => boolean = () => false,
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

  /**
   * Reads the audit trail — the everyday read.
   *
   * Tenant scoping (PII F2), applied only where a tenant dimension exists:
   * - When a tenant is present in the ambient context, the read is FORCED to
   *   that tenant. Any caller-supplied `query.tenantId` is ignored/overridden
   *   (the context tenant is spread LAST so it always wins), so a tenant-facing
   *   handler that forwards client input — e.g. `trail({ tenantId: req.query.tenantId })`
   *   — can never widen the scope and read another tenant's trail.
   * - With no tenant in context, an explicit single-tenant read
   *   (`trail({ tenantId })`) is honoured.
   * - With no tenant in context and no explicit `tenantId`, the behavior depends
   *   on whether the app is multi-tenant at all:
   *   - **Tenancy registered** (`@basaltkit/tenancy` present): the read is
   *     REFUSED. Returning every tenant's records must be a deliberate,
   *     system-only act via {@link systemTrail}, never the silent default.
   *   - **No tenancy** (single-tenant/non-SaaS app): there is no tenant
   *     dimension to scope to, so this is simply "read the trail" and returns
   *     the rows. `@basaltkit/audit` is a general-purpose package; it must work
   *     without the opt-in SaaS layer.
   */
  async trail(query: AuditQuery = {}): Promise<AuditEntry[]> {
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ctxTenantId !== undefined) {
      // Force the scope: spread the context tenant LAST so a differing
      // caller-supplied `tenantId` cannot override it.
      return this.store.query({ ...query, tenantId: ctxTenantId })
    }
    if (query.tenantId !== undefined) {
      // No context, but the caller explicitly pinned a single tenant.
      return this.store.query(query)
    }
    if (!this.tenancyActive()) {
      // Single-tenant app: no tenant dimension, so an unscoped read is correct
      // and is the everyday call. Nothing to widen — every entry is "ours".
      return this.store.query(query)
    }
    // Multi-tenant app with no tenant to scope to and no explicit tenant
    // pinned: refuse to silently return every tenant's records. Cross-tenant /
    // system reads go through systemTrail() so broad access is deliberate.
    throw new Error(
      'Audit.trail() requires a tenant in context or an explicit `tenantId`. ' +
        'For a deliberate system-wide, cross-tenant read use Audit.systemTrail().',
    )
  }

  /**
   * SYSTEM-ONLY escape hatch: reads across ALL tenants (or whatever
   * `query.tenantId` explicitly pins), bypassing the tenant auto-scoping that
   * {@link trail} enforces.
   *
   * This exists for trusted platform/admin tooling only. NEVER call it with, or
   * forward into it, client-controlled input — doing so re-opens the
   * cross-tenant data-exposure that {@link trail} closes.
   */
  async systemTrail(query: AuditQuery = {}): Promise<AuditEntry[]> {
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

  /**
   * Called when a *bridged* capture fails — a hook or event the plugin picked
   * up automatically. Defaults to logging.
   *
   * The bridge is opportunistic: it must never fail (or slow down) the domain
   * write that emitted the hook, the same rule `@basaltkit/realtime` applies to
   * its own bridge. A deliberate `audit.record()` still throws, because there
   * the audit *is* the operation.
   *
   * The default logs rather than staying quiet: a trail with a silent hole is
   * worse than no trail, because it looks complete.
   */
  onCaptureError?: (error: unknown, info: { source: 'hook' | 'event'; event: string }) => void
}

/**
 * `tenancy:created` and not `tenancy:**`.
 *
 * `tenancy:switched` fires on every HTTP request that resolves a tenant, so
 * capturing it by default wrote one audit row per request, forever — a
 * compliance trail drowned in routing noise.
 *
 * Worse, it also fires *inside* the new tenant's context during
 * `provision()`, before the tenant's storage exists. With a store bound to the
 * tenant's own database that write failed, the error propagated out through
 * `provision()`, and the tenant was marked failed: an application on the
 * default configuration could not create a single tenant.
 *
 * Tenant lifecycle is worth auditing; context switching is routing. The two
 * were only ever together because one wildcard covered both.
 */
const DEFAULT_HOOK_PATTERNS = ['auth:**', 'billing:**', 'tenancy:created', 'permission:**']

export function auditPlugin(options: AuditPluginOptions = {}) {
  const hookPatterns = options.hooks ?? DEFAULT_HOOK_PATTERNS
  const eventPatterns = options.events ?? ['**']
  const onCaptureError =
    options.onCaptureError ??
    ((error: unknown, info: { source: 'hook' | 'event'; event: string }) =>
      console.error(
        `[basalt:audit] capture failed for ${info.source} "${info.event}" — the operation continued, this entry is missing from the trail:`,
        error,
      ))

  return definePlugin({
    name: 'basalt:audit',
    register({ container, hooks }) {
      // The 'tenancy:active' marker is set by tenancyPlugin. Reading it here
      // (a string-keyed metadata bucket, not an import) is how a generic
      // package learns the app is multi-tenant without depending on
      // @basaltkit/tenancy — the same signal @basaltkit/cache uses. It is
      // resolved per call, so plugin registration order does not matter.
      const metadata = ensureMetadata(container)
      const tenancyActive = () => metadata.get('tenancy:active').length > 0
      container.singleton(
        AUDIT,
        () => new Audit(options.store ?? new MemoryAuditStore(), options.redact ?? defaultAuditRedactor, tenancyActive),
      )

      hooks.onAny(async (hook, payload) => {
        if (!hookPatterns.some((pattern) => patternMatches(pattern, hook))) return
        try {
          await container.get(AUDIT).capture('hook', hook, payload)
        } catch (error) {
          onCaptureError(error, { source: 'hook', event: hook })
        }
      })
    },
    boot({ container }) {
      if (eventPatterns.length === 0 || !container.has(EVENTS)) return
      const bus = container.get(EVENTS)
      bus.on('**', async (payload, meta) => {
        if (!eventPatterns.some((pattern) => patternMatches(pattern, meta.name))) return
        try {
          await container.get(AUDIT).capture('event', meta.name, payload)
        } catch (error) {
          onCaptureError(error, { source: 'event', event: meta.name })
        }
      })
    },
  })
}
