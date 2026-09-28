import type { ActivityQuery, ActivityRecord, ActivityStore } from '@basaltkit/activity'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_MEDIUMTEXT,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/activity-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/activity` `ActivityStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `ActivityRecord` model (see the bundled
 * `prisma/schema.prisma`). The production counterpart to `@basaltkit/activity-sqlite`.
 */

interface PActivity {
  id: string
  log: string
  description: string
  subjectType: string | null
  subjectId: string | null
  causerId: string | null
  tenantId: string | null
  properties: string | null
  at: Date
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaActivityClient {
  activityRecord: {
    findMany(a: any): Promise<PActivity[]>
    create(a: any): Promise<PActivity>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const at = (n: number): Date => new Date(n)

const toRecord = (r: PActivity): ActivityRecord => ({
  id: r.id,
  log: r.log,
  description: r.description,
  subjectType: r.subjectType ?? undefined,
  subjectId: r.subjectId ?? undefined,
  causerId: r.causerId ?? undefined,
  tenantId: r.tenantId ?? undefined,
  properties: r.properties === null ? undefined : (JSON.parse(r.properties) as Record<string, unknown>),
  at: r.at.getTime(),
})

/** The `ActivityRecord` columns the store writes as strings. */
export type ActivityColumn =
  | 'id'
  | 'log'
  | 'description'
  | 'subjectType'
  | 'subjectId'
  | 'causerId'
  | 'tenantId'
  | 'properties'

export type ActivityColumnLimits = ColumnLimits<{ ActivityRecord: ActivityColumn }>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Spread it to override one column after widening it.
 */
export const activityMysqlColumnLimits: ActivityColumnLimits = {
  ActivityRecord: {
    id: V,
    log: V,
    description: MYSQL_TEXT,
    subjectType: V,
    subjectId: V,
    causerId: V,
    tenantId: V,
    properties: MYSQL_MEDIUMTEXT,
  },
}

export interface PrismaActivityStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a cut
   * `properties` is no longer valid JSON and the feed cannot be read back.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and SQLite
   * store any length).
   */
  columnLimits?: 'mysql' | ActivityColumnLimits
}

export class PrismaActivityStore implements ActivityStore {
  private readonly limits: ActivityColumnLimits | undefined

  constructor(
    private readonly client: PrismaActivityClient,
    options: PrismaActivityStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, activityMysqlColumnLimits)
  }

  async append(record: ActivityRecord): Promise<void> {
    const data = {
      id: record.id,
      log: record.log,
      description: record.description,
      subjectType: record.subjectType ?? null,
      subjectId: record.subjectId ?? null,
      causerId: record.causerId ?? null,
      tenantId: record.tenantId ?? null,
      properties: record.properties === undefined ? null : JSON.stringify(record.properties),
      at: at(record.at),
    }
    assertColumnLengths(PKG, this.limits, 'ActivityRecord', data)
    await this.client.activityRecord.create({ data })
  }

  async query(query: ActivityQuery): Promise<ActivityRecord[]> {
    const where: Record<string, unknown> = {}
    if (query.log !== undefined) where.log = query.log
    if (query.subjectType !== undefined) where.subjectType = query.subjectType
    if (query.subjectId !== undefined) where.subjectId = query.subjectId
    if (query.causerId !== undefined) where.causerId = query.causerId
    if (query.tenantId !== undefined) where.tenantId = query.tenantId
    const args: Record<string, unknown> = {
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }], // newest first, deterministic ties
    }
    if (query.limit !== undefined) args.take = query.limit
    const rows = await this.client.activityRecord.findMany(args)
    return rows.map(toRecord)
  }
}

export interface PrismaActivityStores {
  store: PrismaActivityStore
}

/**
 * Wire the activity store to your Prisma client, named to drop straight into
 * `activityPlugin`:
 *
 * ```ts
 * const a = prismaActivityStore(prisma) // on MySQL: prismaActivityStore(prisma, { columnLimits: 'mysql' })
 * activityPlugin({ store: a.store })
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

export function prismaActivityStore(
  client: PrismaActivityClient,
  options: PrismaActivityStoreOptions = {},
): PrismaActivityStores {
  ensureModel(client, 'activityRecord', PKG)
  return { store: new PrismaActivityStore(client, options) }
}
