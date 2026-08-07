import { MachizeError, tryCtx } from '@machize/core'
import type { Audit, AuditEntry } from '@machize/audit'

export class AuditTenantRequiredError extends MachizeError {
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
  total: number
  limit: number
  offset: number
}

export interface AuditStats {
  total: number
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
}

const DAY = 86_400_000

/**
 * Read-only lens over the append-only audit trail: tenant-scoped, filterable,
 * paginated queries plus aggregate stats. Wraps {@link Audit}; the trail itself
 * stays immutable.
 */
export class AuditViewer {
  private readonly bucketMs: number
  private readonly topN: number

  constructor(
    private readonly audit: Audit,
    options: AuditViewerOptions = {},
  ) {
    this.bucketMs = options.bucketMs ?? DAY
    this.topN = options.topN ?? 20
  }

  async page(query: ViewerQuery = {}): Promise<AuditPage> {
    const all = await this.match(query)
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    return { entries: all.slice(offset, offset + limit), total: all.length, limit, offset }
  }

  async get(id: string, tenantId?: string): Promise<AuditEntry | null> {
    const all = await this.match({ ...(tenantId !== undefined ? { tenantId } : {}) })
    return all.find((entry) => entry.id === id) ?? null
  }

  async stats(query: ViewerQuery = {}): Promise<AuditStats> {
    const all = await this.match(query)
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
      byEvent: this.top(byEvent).map(([event, count]) => ({ event, count })),
      byActor: this.top(byActor).map(([actorId, count]) => ({ actorId, count })),
      bySource,
      timeline: [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at, count })),
    }
  }

  /** Matching entries (newest first), after the extra source/until filters. */
  private async match(query: ViewerQuery): Promise<AuditEntry[]> {
    const tenantId = this.tenant(query.tenantId)
    const trail = await this.audit.trail({
      tenantId,
      ...(query.event !== undefined ? { event: query.event } : {}),
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
    })
    return trail.filter(
      (entry) =>
        (query.source === undefined || entry.source === query.source) &&
        (query.until === undefined || entry.at <= query.until),
    )
  }

  private top(counts: Map<string, number>): [string, number][] {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.topN)
  }

  private tenant(explicit?: string): string {
    const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (!id) throw new AuditTenantRequiredError()
    return id
  }
}
