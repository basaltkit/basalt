import type { ActivityQuery, ActivityRecord, ActivityStore } from '@machize/activity'

/**
 * Prisma-backed implementation of the `@machize/activity` `ActivityStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `ActivityRecord` model (see the bundled
 * `prisma/schema.prisma`). The production counterpart to `@machize/activity-sqlite`.
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

export class PrismaActivityStore implements ActivityStore {
  constructor(private readonly client: PrismaActivityClient) {}

  async append(record: ActivityRecord): Promise<void> {
    await this.client.activityRecord.create({
      data: {
        id: record.id,
        log: record.log,
        description: record.description,
        subjectType: record.subjectType ?? null,
        subjectId: record.subjectId ?? null,
        causerId: record.causerId ?? null,
        tenantId: record.tenantId ?? null,
        properties: record.properties === undefined ? null : JSON.stringify(record.properties),
        at: at(record.at),
      },
    })
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
 * const a = prismaActivityStore(prisma)
 * activityPlugin({ store: a.store })
 * ```
 */
export function prismaActivityStore(client: PrismaActivityClient): PrismaActivityStores {
  return { store: new PrismaActivityStore(client) }
}
