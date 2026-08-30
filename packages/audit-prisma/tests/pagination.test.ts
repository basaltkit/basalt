import type { AuditEntry } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { PrismaAuditStore, type PrismaAuditClient } from '../src/index.js'

interface ARow {
  id: string; source: string; event: string; payload: string | null
  actorId: string | null; tenantId: string | null; requestId: string | null; at: Date
}

/** Fake client that honours take/skip and records how many rows it handed back. */
function makeFakeClient() {
  const rows: ARow[] = []
  const stats = { rowsRead: 0, calls: 0 }
  const client: PrismaAuditClient = {
    auditEntry: {
      async create({ data }: { data: ARow }) {
        const row = { ...data }
        rows.push(row)
        return row
      },
      async findMany(args: Record<string, unknown>) {
        const where = (args['where'] ?? {}) as Record<string, never>
        let out = rows.filter(
          (r) =>
            (where['tenantId'] === undefined || r.tenantId === where['tenantId']) &&
            (where['actorId'] === undefined || r.actorId === where['actorId']) &&
            (where['event'] === undefined || r.event === where['event']),
        )
        out = out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
        const skip = (args['skip'] as number | undefined) ?? 0
        const take = args['take'] as number | undefined
        out = out.slice(skip, take === undefined ? undefined : skip + take)
        stats.calls++
        stats.rowsRead += out.length
        return out
      },
    },
  } as unknown as PrismaAuditClient
  return { client, stats }
}

const entry = (over: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'event' | 'at'>): AuditEntry => ({
  source: 'hook', payload: undefined, ...over,
})

async function seed(store: PrismaAuditStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.append(entry({ id: `a${String(i).padStart(5, '0')}`, event: i % 10 === 0 ? 'auth:login' : 'noise:tick', at: i, tenantId: 't1' }))
  }
}

describe('F-5 · audit-prisma pushes the limit down', () => {
  it('a limited query does not materialise the whole trail', async () => {
    const { client, stats } = makeFakeClient()
    const store = new PrismaAuditStore(client)
    await seed(store, 5_000)

    const page = await store.query({ tenantId: 't1', limit: 50 })

    expect(page).toHaveLength(50)
    expect(stats.rowsRead).toBeLessThan(500)
  })

  it('an exact event name is pushed into the WHERE clause', async () => {
    const { client, stats } = makeFakeClient()
    const store = new PrismaAuditStore(client)
    await seed(store, 5_000)

    const page = await store.query({ tenantId: 't1', event: 'auth:login', limit: 10 })

    expect(page.map((e) => e.event)).toEqual(Array(10).fill('auth:login'))
    expect(stats.rowsRead).toBeLessThan(100)
  })

  it('a wildcard event scans in bounded pages, not one big load', async () => {
    const { client, stats } = makeFakeClient()
    const store = new PrismaAuditStore(client)
    await seed(store, 5_000)

    const page = await store.query({ tenantId: 't1', event: 'auth:**', limit: 5 })

    expect(page.map((e) => e.event)).toEqual(Array(5).fill('auth:login'))
    expect(stats.rowsRead).toBeLessThan(2_000)
  })

  it('still returns everything matched when no limit is given', async () => {
    const { client } = makeFakeClient()
    const store = new PrismaAuditStore(client)
    await seed(store, 300)

    expect(await store.query({ tenantId: 't1', event: 'auth:**' })).toHaveLength(30)
  })
})
