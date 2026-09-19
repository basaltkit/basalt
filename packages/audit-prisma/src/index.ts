import {
  AUDIT_SCAN_PAGE,
  assertAuditLimit,
  AuditChainConflictError,
  auditChainKey,
  type AuditChainHead,
  type AuditChainRange,
  type AuditEntry,
  type AuditQuery,
  type AuditStore,
  exactEventMatch,
  parseAuditChainKey,
  patternMatches,
} from '@basaltkit/audit'

/**
 * Prisma-backed implementation of the `@basaltkit/audit` `AuditStore` for
 * production databases (PostgreSQL, MySQL, …). Append-only by contract. Bring
 * your generated `PrismaClient` with the `AuditEntry` model (see the bundled
 * `prisma/schema.prisma`). The production counterpart to `@basaltkit/audit-sqlite`.
 */

interface PAuditEntry {
  id: string
  source: string
  event: string
  payload: string | null
  actorId: string | null
  tenantId: string | null
  requestId: string | null
  at: Date
  // Added in @basaltkit/audit-prisma 1.2 — absent on clients generated from an
  // older schema, NULL on rows written before integrity/request capture was on.
  chain?: string | null
  seq?: number | null
  prevHash?: string | null
  hash?: string | null
  ip?: string | null
  userAgent?: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaAuditClient {
  auditEntry: {
    findMany(a: any): Promise<PAuditEntry[]>
    create(a: any): Promise<PAuditEntry>
    /** Used by `verify()` to count unchained legacy rows (every generated client has it). */
    count?(a: any): Promise<number>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const at = (n: number): Date => new Date(n)

const toEntry = (r: PAuditEntry): AuditEntry => ({
  id: r.id,
  source: r.source as AuditEntry['source'],
  event: r.event,
  payload: r.payload === null ? undefined : (JSON.parse(r.payload) as unknown),
  actorId: r.actorId ?? undefined,
  tenantId: r.tenantId ?? undefined,
  requestId: r.requestId ?? undefined,
  at: r.at.getTime(),
  ...(r.ip != null ? { ip: r.ip } : {}),
  ...(r.userAgent != null ? { userAgent: r.userAgent } : {}),
  ...(r.seq != null ? { seq: r.seq } : {}),
  ...(r.prevHash != null ? { prevHash: r.prevHash } : {}),
  ...(r.hash != null ? { hash: r.hash } : {}),
})

/**
 * A unique violation (`P2002`) on the `(chain, seq)` constraint — another
 * replica extended the chain first. Prisma reports the target as field names
 * or as the constraint/index name depending on the database, so either form is
 * matched; a violation naming only another field (the primary key) is not one.
 */
function isChainConflict(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { target?: unknown } } | null
  if (e?.code !== 'P2002') return false
  const target = e.meta?.target
  if (target === undefined) return true
  const text = Array.isArray(target) ? target.join(',') : String(target)
  return /chain|seq/i.test(text)
}

export class PrismaAuditStore implements AuditStore {
  constructor(private readonly client: PrismaAuditClient) {}

  async append(entry: AuditEntry): Promise<void> {
    // The 1.2 columns are only sent when set: an app that upgrades without
    // enabling integrity / request capture keeps working on its old schema.
    const data: Record<string, unknown> = {
      id: entry.id,
      source: entry.source,
      event: entry.event,
      payload: entry.payload === undefined ? null : JSON.stringify(entry.payload),
      actorId: entry.actorId ?? null,
      tenantId: entry.tenantId ?? null,
      requestId: entry.requestId ?? null,
      at: at(entry.at),
    }
    if (entry.seq !== undefined) {
      data.chain = auditChainKey(entry.tenantId)
      data.seq = entry.seq
      data.prevHash = entry.prevHash ?? null
      data.hash = entry.hash ?? null
    }
    if (entry.ip !== undefined) data.ip = entry.ip
    if (entry.userAgent !== undefined) data.userAgent = entry.userAgent
    try {
      await this.client.auditEntry.create({ data })
    } catch (error) {
      if (entry.seq !== undefined && isChainConflict(error)) {
        throw new AuditChainConflictError(entry.tenantId, entry.seq, { cause: error })
      }
      throw error
    }
  }

  async chainHead(tenantId: string | undefined): Promise<AuditChainHead | undefined> {
    const [row] = await this.client.auditEntry.findMany({
      where: { chain: auditChainKey(tenantId), seq: { not: null } },
      orderBy: [{ seq: 'desc' }],
      take: 1,
    })
    return row?.seq != null && row.hash != null ? { seq: row.seq, hash: row.hash } : undefined
  }

  async readChain(tenantId: string | undefined, range: AuditChainRange): Promise<AuditEntry[]> {
    assertAuditLimit(range.limit)
    const seq: Record<string, number> = { gte: range.fromSeq }
    if (range.toSeq !== undefined) seq.lte = range.toSeq
    const rows = await this.client.auditEntry.findMany({
      where: { chain: auditChainKey(tenantId), seq },
      orderBy: [{ seq: 'asc' }],
      take: range.limit,
    })
    return rows.map(toEntry)
  }

  async countUnchained(tenantId: string | undefined): Promise<number> {
    const where = { seq: null, tenantId: tenantId ?? null }
    if (this.client.auditEntry.count) return this.client.auditEntry.count({ where })
    return (await this.client.auditEntry.findMany({ where, select: { id: true } })).length
  }

  async chainTenants(): Promise<Array<string | undefined>> {
    const rows = await this.client.auditEntry.findMany({
      where: { chain: { not: null } },
      distinct: ['chain'],
      select: { chain: true },
    })
    return rows.map((r) => parseAuditChainKey(r.chain as string))
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    // Exact filters — including an event name with no wildcard — push down to the
    // database, and so does the limit. Only a wildcard pattern still needs matching
    // in code, and then the rows are read in bounded pages: a `limit: 50` query must
    // never materialise the whole (unbounded) trail.
    const where: Record<string, unknown> = {}
    if (query.tenantId !== undefined) where.tenantId = query.tenantId
    if (query.actorId !== undefined) where.actorId = query.actorId
    if (query.since !== undefined) where.at = { gte: at(query.since) }
    const exact = exactEventMatch(query.event)
    if (exact !== undefined) where.event = exact
    const orderBy = [{ at: 'desc' }, { id: 'desc' }] // newest first, deterministic ties
    const needsPatternMatch = query.event !== undefined && exact === undefined

    if (!needsPatternMatch) {
      const rows = await this.client.auditEntry.findMany({
        where,
        orderBy,
        ...(query.limit !== undefined ? { take: query.limit } : {}),
      })
      return rows.map(toEntry)
    }

    const pattern = query.event as string
    const out: AuditEntry[] = []
    for (let skip = 0; ; skip += AUDIT_SCAN_PAGE) {
      const rows = await this.client.auditEntry.findMany({ where, orderBy, take: AUDIT_SCAN_PAGE, skip })
      for (const row of rows) {
        const entry = toEntry(row)
        if (!patternMatches(pattern, entry.event)) continue
        out.push(entry)
        if (query.limit !== undefined && out.length >= query.limit) return out
      }
      if (rows.length < AUDIT_SCAN_PAGE) return out
    }
  }
}

export interface PrismaAuditStores {
  store: PrismaAuditStore
}

/**
 * Wire the audit store to your Prisma client, named to drop straight into
 * `auditPlugin`:
 *
 * ```ts
 * const a = prismaAuditStore(prisma)
 * auditPlugin({ store: a.store })
 * ```
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaAuditStore(client: PrismaAuditClient): PrismaAuditStores {
  ensureModel(client, 'auditEntry', '@basaltkit/audit-prisma')
  return { store: new PrismaAuditStore(client) }
}
