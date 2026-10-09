import {
  AUDIT_SCAN_PAGE,
  assertAuditLimit,
  assertAuditQuery,
  AuditChainConflictError,
  auditChainKey,
  AuditRedactionConflictError,
  type AuditRedactionMarker,
  AuditRedactionRefusedError,
  type AuditRedactionWrite,
  auditStableJson,
  parseAuditHash,
  type AuditChainHead,
  type AuditChainRange,
  type AuditEntry,
  type AuditQuery,
  type AuditStore,
  type AuditUnchainedRange,
  exactEventMatch,
  parseAuditChainKey,
  patternMatches,
} from '@basaltkit/audit'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_MEDIUMTEXT,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/audit-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/audit` `AuditStore` for
 * production databases (PostgreSQL, MySQL, …). Append-only by contract — the
 * one in-place change is `redact()`, an attested erasure. Bring
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
  // Added in @basaltkit/audit-prisma 2.1 — the marker of an attested erasure.
  redaction?: string | null
  redactedBy?: string | null
  /** v3 hashes only (`integrity.erasable`). */
  nonce?: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaAuditClient {
  auditEntry: {
    findMany(a: any): Promise<PAuditEntry[]>
    create(a: any): Promise<PAuditEntry>
    /** Used by `verify()` to count unchained legacy rows (every generated client has it). */
    count?(a: any): Promise<number>
    /** Used by `get()` (falls back to `findMany`). Every generated client has it. */
    findUnique?(a: any): Promise<PAuditEntry | null>
    /** Used by `redact()`. Every generated client has it. */
    updateMany?(a: any): Promise<{ count: number }>
  }
  /** Interactive transaction, used by `redact()`. Every generated client has it. */
  $transaction?(fn: (tx: any) => Promise<any>, options?: any): Promise<any>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const at = (n: number): Date => new Date(n)

/**
 * The redaction marker of a row, or `undefined` when it has none. A half-set
 * or unparsable marker is returned malformed rather than dropped, so
 * `verify()` fails closed (`redaction-mismatch`) instead of silently reading
 * the row as unredacted.
 */
function toMarker(r: PAuditEntry): AuditRedactionMarker | undefined {
  if (r.redaction == null && r.redactedBy == null) return undefined
  let erased: unknown
  try {
    erased = r.redaction == null ? undefined : (JSON.parse(r.redaction) as unknown)
  } catch {
    erased = undefined
  }
  return { ...(erased !== null && typeof erased === 'object' ? erased : {}), attestationId: r.redactedBy } as AuditRedactionMarker
}

const toEntry = (r: PAuditEntry): AuditEntry => {
  const redaction = toMarker(r)
  return {
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
    ...(r.nonce != null ? { nonce: r.nonce } : {}),
    ...(redaction !== undefined ? { redaction } : {}),
  }
}

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

/** The `AuditEntry` columns the store writes as strings. */
export type AuditColumn =
  | 'id'
  | 'source'
  | 'event'
  | 'payload'
  | 'actorId'
  | 'tenantId'
  | 'requestId'
  | 'ip'
  | 'userAgent'
  | 'chain'
  | 'prevHash'
  | 'hash'
  | 'redaction'
  | 'redactedBy'
  | 'nonce'

export type AuditColumnLimits = ColumnLimits<{ AuditEntry: AuditColumn }>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Spread it to override one column after widening it.
 */
export const auditMysqlColumnLimits: AuditColumnLimits = {
  AuditEntry: {
    id: V,
    source: V,
    event: V,
    payload: MYSQL_MEDIUMTEXT,
    actorId: V,
    tenantId: V,
    requestId: V,
    ip: V,
    userAgent: MYSQL_TEXT,
    chain: V,
    prevHash: V,
    hash: V,
    redaction: MYSQL_TEXT,
    redactedBy: V,
    nonce: V,
  },
}

export interface PrismaAuditStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a
   * truncated payload or hash silently breaks the hash chain. `'mysql'` uses
   * the limits of the bundled `schema.mysql.prisma`; pass an object for a
   * schema of your own. Default: unchecked (PostgreSQL and SQLite store any
   * length).
   */
  columnLimits?: 'mysql' | AuditColumnLimits
}

export class PrismaAuditStore implements AuditStore {
  private readonly limits: AuditColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuditClient,
    options: PrismaAuditStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, auditMysqlColumnLimits)
  }

  async append(entry: AuditEntry): Promise<void> {
    const data = this.toData(entry)
    try {
      await this.client.auditEntry.create({ data })
    } catch (error) {
      if (entry.seq !== undefined && isChainConflict(error)) {
        throw new AuditChainConflictError(entry.tenantId, entry.seq, { cause: error })
      }
      throw error
    }
  }

  /** The row to insert for `entry`, length-checked. */
  private toData(entry: AuditEntry): Record<string, unknown> {
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
    // Only v3 entries (integrity.erasable) carry one: apps that do not opt in
    // need no `nonce` column.
    if (entry.nonce !== undefined) data.nonce = entry.nonce
    // Before the insert: a truncated row would be written and then fail
    // verification forever; a refused one leaves the chain as it was.
    assertColumnLengths(PKG, this.limits, 'AuditEntry', data)
    return data
  }

  async get(id: string): Promise<AuditEntry | undefined> {
    // A non-string id (an object from a parsed query string) would be read by
    // Prisma as a filter operator.
    if (typeof id !== 'string') throw new TypeError('get: `id` must be a string')
    const delegate = this.client.auditEntry
    const row =
      typeof delegate.findUnique === 'function'
        ? await delegate.findUnique({ where: { id } })
        : (await delegate.findMany({ where: { id }, take: 1 }))[0]
    return row == null ? undefined : toEntry(row)
  }

  /**
   * The attested erasure, in one interactive transaction: an `updateMany`
   * conditioned on the row's `hash` and `redactedBy` still equalling `expect`
   * (count ≠ 1 → {@link AuditRedactionConflictError}), then the attestation's
   * insert under the `(chain, seq)` unique constraint (`AuditChainConflictError`).
   * Any error rolls both back. Needs the `redaction` / `redactedBy` columns of
   * the 2.1 schema.
   */
  async redact(write: AuditRedactionWrite): Promise<void> {
    const client = this.client
    if (typeof client.$transaction !== 'function' || typeof client.auditEntry.updateMany !== 'function') {
      throw new AuditRedactionRefusedError(
        'unsupported-store',
        `${PKG}: redact() needs a Prisma client with $transaction and auditEntry.updateMany ` +
          '(every generated PrismaClient has both — a hand-written client or an extension must expose them).',
      )
    }
    const { attestationId, ...erased } = write.redaction
    const update: Record<string, unknown> = {
      payload: write.payload === undefined ? null : JSON.stringify(write.payload),
      ip: write.ip ?? null,
      userAgent: write.userAgent ?? null,
      redaction: auditStableJson(erased),
      redactedBy: attestationId,
    }
    // A v3 row has a nonce to destroy (and therefore the column); clearing it on
    // other rows would make the 2.1 schema without `nonce` fail for nothing.
    if (parseAuditHash(write.expect.hash)?.version === 3) update.nonce = null
    assertColumnLengths(PKG, this.limits, 'AuditEntry', update)
    const attestation = this.toData(write.attestation)
    await client.$transaction(async (tx: PrismaAuditClient) => {
      const { count } = await tx.auditEntry.updateMany!({
        where: { id: write.id, hash: write.expect.hash ?? null, redactedBy: write.expect.redactedBy ?? null },
        data: update,
      })
      if (count !== 1) throw new AuditRedactionConflictError(write.id)
      try {
        await tx.auditEntry.create({ data: attestation })
      } catch (error) {
        if (write.attestation.seq !== undefined && isChainConflict(error)) {
          throw new AuditChainConflictError(write.attestation.tenantId, write.attestation.seq, { cause: error })
        }
        throw error
      }
    })
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

  /**
   * Rows of the tenant outside its chain: no `seq`, a `seq` below 1, or a
   * `chain` other than the tenant's (NULL or a forged name). Those claiming a
   * chain position are returned whatever their `at` — a legacy row has neither.
   * Spelled with `OR` rather than `NOT`: SQL `NOT (chain = x AND …)` is NULL,
   * not true, for a NULL `chain`, and would hide exactly the rows sought.
   */
  async readUnchained(tenantId: string | undefined, range: AuditUnchainedRange): Promise<AuditEntry[]> {
    assertAuditLimit(range.limit)
    if (typeof range.since !== 'number' || !Number.isFinite(range.since)) throw new TypeError('readUnchained: `since` must be a finite number')
    const rows = await this.client.auditEntry.findMany({
      where: {
        tenantId: tenantId ?? null,
        AND: [
          { OR: [{ chain: null }, { chain: { not: auditChainKey(tenantId) } }, { seq: null }, { seq: { lt: 1 } }] },
          { OR: [{ at: { gte: at(range.since) } }, { seq: { not: null } }, { chain: { not: null } }] },
        ],
      },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
      take: range.limit,
    })
    return rows.map(toEntry)
  }

  async chainTenants(): Promise<Array<string | undefined>> {
    const rows = await this.client.auditEntry.findMany({
      where: { chain: { not: null } },
      distinct: ['chain'],
      select: { chain: true },
    })
    return rows.map((r) => parseAuditChainKey(r.chain as string))
  }

  /**
   * Every tenant with at least one row, chained or not (`undefined` = rows
   * without a tenant) — a `SELECT DISTINCT "tenantId"` (served by the
   * `[tenantId, at]` index), so `verifyAll()` reaches chainless tenants without
   * reading the whole trail.
   */
  async auditTenants(): Promise<Array<string | undefined>> {
    const rows = await this.client.auditEntry.findMany({ distinct: ['tenantId'], select: { tenantId: true } })
    return rows.map((r) => r.tenantId ?? undefined)
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    // Validated here too, not only in Audit.trail(): the store is public API, and
    // a filter that is an object (`{ not: 'x' }` from `?tenantId[not]=x`) would be
    // read by Prisma as an operator, and a string `limit` would reach `take`.
    assertAuditQuery(query)
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
    if (query.chainedOnly === true) {
      // Prisma cannot compare two columns, so "the chain its own tenant maps
      // to" is checked in code below (on the paged path).
      where.seq = { gte: 1 }
      where.chain = { not: null }
    }
    const orderBy = [{ at: 'desc' }, { id: 'desc' }] // newest first, deterministic ties
    const needsPatternMatch = query.event !== undefined && exact === undefined
    const needsCodeFilter = needsPatternMatch || query.chainedOnly === true
    const keep = (row: PAuditEntry, entry: AuditEntry): boolean =>
      (!needsPatternMatch || patternMatches(query.event as string, entry.event)) &&
      (query.chainedOnly !== true || row.chain === auditChainKey(entry.tenantId))

    if (!needsCodeFilter) {
      const rows = await this.client.auditEntry.findMany({
        where,
        orderBy,
        ...(query.limit !== undefined ? { take: query.limit } : {}),
      })
      return rows.map(toEntry)
    }

    const out: AuditEntry[] = []
    for (let skip = 0; ; skip += AUDIT_SCAN_PAGE) {
      const rows = await this.client.auditEntry.findMany({ where, orderBy, take: AUDIT_SCAN_PAGE, skip })
      for (const row of rows) {
        const entry = toEntry(row)
        if (!keep(row, entry)) continue
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
 * const a = prismaAuditStore(prisma) // on MySQL: prismaAuditStore(prisma, { columnLimits: 'mysql' })
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

export function prismaAuditStore(client: PrismaAuditClient, options: PrismaAuditStoreOptions = {}): PrismaAuditStores {
  ensureModel(client, 'auditEntry', PKG)
  return { store: new PrismaAuditStore(client, options) }
}
