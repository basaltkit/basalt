import type { ActivityRecord } from '@basaltkit/activity'
import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaActivityStore, type PrismaActivityClient, prismaActivityStore } from '../src/index.js'

interface RRow {
  id: string; log: string; description: string; subjectType: string | null; subjectId: string | null
  causerId: string | null; tenantId: string | null; properties: string | null; at: Date
}

function makeFakeClient(): PrismaActivityClient {
  const rows: RRow[] = []
  return {
    activityRecord: {
      async create({ data }) {
        const row = { ...data } as RRow
        rows.push(row)
        return row
      },
      async findMany({ where, take }) {
        let out = rows.filter((r) =>
          (['log', 'subjectType', 'subjectId', 'causerId', 'tenantId'] as const).every(
            (f) => where[f] === undefined || r[f] === where[f],
          ),
        )
        out = out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
        return take !== undefined ? out.slice(0, take) : out
      },
    },
  }
}

const rec = (over: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'description' | 'at'>): ActivityRecord => ({
  log: 'default', ...over,
})

let client: PrismaActivityClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaActivityStore', () => {
  it('appends and queries newest-first with filters and limit', async () => {
    const store = new PrismaActivityStore(client)
    await store.append(rec({ id: 'r1', description: 'created', at: 10, tenantId: 't1', causerId: 'u1', subjectType: 'project', subjectId: 'p1', properties: { to: 'draft' } }))
    await store.append(rec({ id: 'r2', description: 'published', at: 20, tenantId: 't1', causerId: 'u2', subjectType: 'project', subjectId: 'p1', log: 'project' }))
    await store.append(rec({ id: 'r3', description: 'other', at: 30, tenantId: 't2', causerId: 'u1' }))

    expect((await store.query({})).map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect((await store.query({ tenantId: 't1' })).map((r) => r.id)).toEqual(['r2', 'r1'])
    expect((await store.query({ log: 'project' })).map((r) => r.id)).toEqual(['r2'])
    expect((await store.query({ subjectType: 'project', subjectId: 'p1' })).map((r) => r.id)).toEqual(['r2', 'r1'])
    expect((await store.query({ causerId: 'u1' })).map((r) => r.id)).toEqual(['r3', 'r1'])
    expect((await store.query({ limit: 2 })).map((r) => r.id)).toEqual(['r3', 'r2'])

    const r1 = (await store.query({ tenantId: 't1' })).find((r) => r.id === 'r1')
    expect(r1?.properties).toEqual({ to: 'draft' })
    expect((await store.query({})).find((r) => r.id === 'r3')?.properties).toBeUndefined()

    // a record with no causer/tenant round-trips them as undefined
    await store.append(rec({ id: 'r5', description: 'bare', at: 5 }))
    const r5 = (await store.query({})).find((r) => r.id === 'r5')
    expect(r5?.causerId).toBeUndefined()
    expect(r5?.tenantId).toBeUndefined()
    expect(r5?.subjectType).toBeUndefined()
  })
})

describe('prismaActivityStore', () => {
  it('bundles the store named for activityPlugin', () => {
    expect(prismaActivityStore(client).store).toBeInstanceOf(PrismaActivityStore)
  })
})
