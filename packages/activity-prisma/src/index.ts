import type { ActivityQuery, ActivityRecord, ActivityStore } from '@basaltkit/activity'

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

export function prismaActivityStore(client: PrismaActivityClient): PrismaActivityStores {
  ensureModel(client, 'activityRecord', '@basaltkit/activity-prisma')
  return { store: new PrismaActivityStore(client) }
}
