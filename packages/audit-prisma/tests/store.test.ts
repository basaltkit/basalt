import type { AuditEntry } from '@machize/audit'
import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaAuditStore, type PrismaAuditClient, prismaAuditStore } from '../src/index.js'

interface ARow {
  id: string; source: string; event: string; payload: string | null
  actorId: string | null; tenantId: string | null; requestId: string | null; at: Date
}

function makeFakeClient(): PrismaAuditClient {
  const rows: ARow[] = []
  return {
    auditEntry: {
      async create({ data }) {
        const row = { ...data } as ARow
        rows.push(row)
        return row
      },
      async findMany({ where }) {
        let out = rows.filter(
          (r) =>
            (where.tenantId === undefined || r.tenantId === where.tenantId) &&
            (where.actorId === undefined || r.actorId === where.actorId) &&
            (where.at?.gte === undefined || r.at.getTime() >= where.at.gte.getTime()),
        )
        // orderBy [{at:'desc'},{id:'desc'}]
        out = out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
        return out
      },
    },
  }
}

const entry = (over: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'event' | 'at'>): AuditEntry => ({
  source: 'hook', payload: undefined, ...over,
})

let client: PrismaAuditClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaAuditStore', () => {
  it('appends and queries newest-first with filters, pattern and limit', async () => {
    const store = new PrismaAuditStore(client)
    await store.append(entry({ id: 'a1', event: 'auth:login', at: 10, tenantId: 't1', actorId: 'u1', payload: { ip: '1' } }))
    await store.append(entry({ id: 'a2', event: 'auth:logout', at: 20, tenantId: 't1', actorId: 'u2' }))
    await store.append(entry({ id: 'a3', event: 'order:created', at: 30, tenantId: 't1', actorId: 'u1' }))
    await store.append(entry({ id: 'a4', event: 'auth:login', at: 40, tenantId: 't2', actorId: 'u1' }))

    expect((await store.query({})).map((e) => e.id)).toEqual(['a4', 'a3', 'a2', 'a1'])
    expect((await store.query({})).find((e) => e.id === 'a1')?.payload).toEqual({ ip: '1' })
    expect((await store.query({})).find((e) => e.id === 'a2')?.payload).toBeUndefined()

    expect((await store.query({ tenantId: 't1' })).map((e) => e.id)).toEqual(['a3', 'a2', 'a1'])
    expect((await store.query({ actorId: 'u1' })).map((e) => e.id)).toEqual(['a4', 'a3', 'a1'])
    expect((await store.query({ since: 25 })).map((e) => e.id)).toEqual(['a4', 'a3'])
    expect((await store.query({ event: 'auth:**' })).map((e) => e.id)).toEqual(['a4', 'a2', 'a1'])
    expect((await store.query({ limit: 2 })).map((e) => e.id)).toEqual(['a4', 'a3'])
    expect((await store.query({ event: 'auth:**', limit: 1 })).map((e) => e.id)).toEqual(['a4'])

    // an entry with a requestId and no actor/tenant round-trips both sides
    await store.append(entry({ id: 'a5', event: 'manual:x', at: 50, source: 'manual', requestId: 'req-1' }))
    const a5 = (await store.query({})).find((e) => e.id === 'a5')
    expect(a5?.requestId).toBe('req-1')
    expect(a5?.actorId).toBeUndefined()
    expect(a5?.tenantId).toBeUndefined()
  })
})

describe('prismaAuditStore', () => {
  it('bundles the store named for auditPlugin', () => {
    expect(prismaAuditStore(client).store).toBeInstanceOf(PrismaAuditStore)
  })
})
