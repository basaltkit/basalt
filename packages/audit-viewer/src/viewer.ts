import { BasaltError, tryCtx } from '@basaltkit/core'
import type { Audit, AuditEntry } from '@basaltkit/audit'

export class AuditTenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUDIT_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

export interface ViewerQuery {
  /** Wildcard pattern over the event name (e.g. `auth:**`). */
  event?: string
  actorId?: string
  tenantId?: string
  source?: AuditEntry['source']
  /** Lower/upper time bounds (ms epoch). */
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export interface AuditPage {
  entries: AuditEntry[]
  /** Matches found within the scan window — see `truncated`. */
  total: number
  limit: number
  offset: number
  /** True when the scan hit `maxScan`: there are more matches than `total` reports. */
  truncated: boolean
}

export interface AuditStats {
  /** Entries counted within the scan window — see `truncated`. */
  total: number
  /** True when the scan hit `maxScan`: the aggregates cover only the newest rows. */
  truncated: boolean
  byEvent: { event: string; count: number }[]
  byActor: { actorId: string; count: number }[]
  bySource: Record<string, number>
  /** Counts bucketed by `bucketMs` (default one day), oldest first. */
  timeline: { at: number; count: number }[]
}

export interface AuditViewerOptions {
  /** Timeline bucket size in ms. Default one day. */
  bucketMs?: number
  /** How many rows the byEvent/byActor breakdowns return. Default 20. */
  topN?: number
  /**
   * Upper bound on rows read from the store per call. The trail is unbounded, so
   * an unbounded read is an OOM vector on any endpoint that forwards client input.
   * Results past the bound are reported via `truncated`. Default 10 000.
   */
  maxScan?: number
}

const DAY = 86_400_000
const DEFAULT_MAX_SCAN = 10_000

/**
 * Read-only lens over the append-only audit trail: tenant-scoped, filterable,
 * paginated queries plus aggregate stats. Wraps {@link Audit}; the trail itself
 * stays immutable.
 */
export class AuditViewer {
  private readonly bucketMs: number
  private readonly topN: number
  private readonly maxScan: number

  constructor(
    private readonly audit: Audit,
    options: AuditViewerOptions = {},
    /**
     * Whether the host app is multi-tenant, i.e. whether `@basaltkit/tenancy`
     * is registered. `auditViewerPlugin` wires this to the container's
     * `'tenancy:active'` metadata marker — a signal, not an import, so this
     * generic package never depends on the opt-in SaaS layer.
     *
     * Defaults to `false`: a hand-built viewer behaves single-tenant.
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.bucketMs = options.bucketMs ?? DAY
    this.topN = options.topN ?? 20
    this.maxScan = options.maxScan ?? DEFAULT_MAX_SCAN
  }

  async page(query: ViewerQuery = {}): Promise<AuditPage> {
    const { entries: all, truncated } = await this.match(query)
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    return { entries: all.slice(offset, offset + limit), total: all.length, limit, offset, truncated }
  }

  async get(id: string, tenantId?: string): Promise<AuditEntry | null> {
    const { entries } = await this.match({ ...(tenantId !== undefined ? { tenantId } : {}) })
    return entries.find((entry) => entry.id === id) ?? null
  }

  async stats(query: ViewerQuery = {}): Promise<AuditStats> {
    const { entries: all, truncated } = await this.match(query)
    const byEvent = new Map<string, number>()
    const byActor = new Map<string, number>()
    const bySource: Record<string, number> = {}
    const timeline = new Map<number, number>()

    for (const entry of all) {
      byEvent.set(entry.event, (byEvent.get(entry.event) ?? 0) + 1)
      if (entry.actorId) byActor.set(entry.actorId, (byActor.get(entry.actorId) ?? 0) + 1)
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1
      const bucket = Math.floor(entry.at / this.bucketMs) * this.bucketMs
      timeline.set(bucket, (timeline.get(bucket) ?? 0) + 1)
    }

    return {
      total: all.length,
      truncated,
      byEvent: this.top(byEvent).map(([event, count]) => ({ event, count })),
      byActor: this.top(byActor).map(([actorId, count]) => ({ actorId, count })),
      bySource,
      timeline: [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at, count })),
    }
  }

  /** Matching entries (newest first), after the extra source/until filters. */
  /** Reads at most `maxScan` rows and reports whether the trail had more. */
  private async match(query: ViewerQuery): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    const tenantId = this.tenant(query.tenantId)
    const trail = await this.audit.trail({
      ...(tenantId !== undefined ? { tenantId } : {}),
      limit: this.maxScan,
      ...(query.event !== undefined ? { event: query.event } : {}),
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
    })
    const entries = trail.filter(
      (entry) =>
        (query.source === undefined || entry.source === query.source) &&
        (query.until === undefined || entry.at <= query.until),
    )
    return { entries, truncated: trail.length >= this.maxScan }
  }

  private top(counts: Map<string, number>): [string, number][] {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.topN)
  }

  /**
   * The tenant to scope a read to, or `undefined` when the app has no tenant
   * dimension at all.
   *
   * In a multi-tenant app an unresolvable tenant is an error — an unscoped read
   * would cross tenants. In a single-tenant app (no `tenancyPlugin`) there is
   * nothing to scope to and nothing to cross, so the read proceeds unscoped;
   * `Audit.trail()` applies the same rule one layer down and still forces the
   * ambient tenant whenever one exists.
   */
  private tenant(explicit?: string): string | undefined {
    const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (id) return id
    if (this.tenancyActive()) throw new AuditTenantRequiredError()
    return undefined
  }
}
