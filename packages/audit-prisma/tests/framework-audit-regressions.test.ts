/**
 * Regression tests for FA-016 (rows outside the chain in a SQL store) and
 * FA-020 (Prisma operators smuggled through `tenantId`/`actorId`/`event`, an
 * unvalidated `limit`) against the Prisma store.
 */
import { Audit, AUDIT_CHAIN_GENESIS, type AuditEntry, computeAuditHash } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { PrismaAuditStore, type PrismaAuditClient } from '../src/index.js'
import { cmp, matches, type Where } from './prisma-where.js'

interface Row {
  id: string; source: string; event: string; payload: string | null
  actorId: string | null; tenantId: string | null; requestId: string | null; at: Date
  chain?: string | null; seq?: number | null; prevHash?: string | null; hash?: string | null
}

function fakeClient() {
  const rows: Row[] = []
  const calls: Array<Record<string, unknown>> = []
  const client: PrismaAuditClient & { rows: Row[]; calls: typeof calls } = {
    rows,
    calls,
    auditEntry: {
      async create({ data }: { data: Row }) {
        if (data.seq != null && rows.some((r) => r.chain === data.chain && r.seq === data.seq)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['chain', 'seq'] } })
        }
        rows.push({ ...data })
        return data
      },
      async findMany(args: { where?: Where; orderBy?: Array<Record<string, 'asc' | 'desc'>>; take?: number; skip?: number; distinct?: string[] }) {
        calls.push(args as Record<string, unknown>)
        let out = rows.filter((r) => matches(r, args.where))
        for (const order of [...(args.orderBy ?? [])].reverse()) {
          const [[field, dir]] = Object.entries(order) as [[keyof Row, 'asc' | 'desc']]
          out = [...out].sort((a, b) => cmp(a[field] ?? -Infinity, b[field] ?? -Infinity) * (dir === 'asc' ? 1 : -1))
        }
        if (args.distinct?.includes('chain')) out = out.filter((r, i) => out.findIndex((o) => o.chain === r.chain) === i)
        out = out.slice(args.skip ?? 0)
        return args.take === undefined ? out : out.slice(0, args.take)
      },
      async count({ where }: { where?: Where }) {
        return rows.filter((r) => matches(r, where)).length
      },
    },
  }
  return client
}

const chainOf = (tenantId: string, count: number): AuditEntry[] => {
  let prev = AUDIT_CHAIN_GENESIS
  return Array.from({ length: count }, (_, i) => {
    const linked: AuditEntry = { id: `${tenantId}-${i + 1}`, source: 'manual', event: 'e', payload: { i }, tenantId, at: 1000 + i, seq: i + 1, prevHash: prev }
    const entry = { ...linked, hash: computeAuditHash(linked) }
    prev = entry.hash
    return entry
  })
}

const seeded = async () => {
  const client = fakeClient()
  const store = new PrismaAuditStore(client)
  for (const entry of chainOf('acme', 3)) await store.append(entry)
  const audit = new Audit(store, undefined, undefined, { integrity: 'hash-chain' })
  const insert = (id: string, chain: string | null, seq: number | null, at: number) =>
    client.rows.push({ id, source: 'manual', event: 'user:promoted', payload: '{"role":"admin"}', actorId: null, tenantId: 'acme', requestId: null, at: new Date(at), chain, seq, prevHash: 'zz', hash: 'zz' })
  return { client, store, audit, insert }
}

describe('FA-016 — PrismaAuditStore: rows outside the chain count as broken', () => {
  it('a row with chain = NULL but a seq is reported, whatever its `at`', async () => {
    const { audit, insert } = await seeded()
    insert('forged', null, 2, 1)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, reason: 'unchained-entry', unverified: ['forged'], checked: 3 })
  })

  it('a row under a bogus chain name is reported by verify() and by verifyAll()', async () => {
    const { audit, insert } = await seeded()
    insert('bogus-row', 'bogus', 1, 5000)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, unverified: ['bogus-row'] })
    const all = await audit.verifyAll()
    expect(all.ok).toBe(false)
    expect(all.chains.find((c) => c.tenantId === 'bogus')).toMatchObject({ ok: false, reason: 'unknown-chain' })
  })

  it('legacy seq-less rows stay ok; one written after the chain began does not', async () => {
    const { audit, insert } = await seeded()
    insert('legacy', null, null, 1)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, unchained: 1, unverified: [] })
    insert('late', null, null, 9999)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, unverified: ['late'] })
  })

  it('trail({ chainedOnly: true }) only returns rows in their own tenant chain', async () => {
    const { audit, insert } = await seeded()
    insert('null-chain', null, 7, 5000)
    insert('other-chain', 't:globex', 8, 5001)
    insert('plain', null, null, 5002)
    const ids = (await audit.trail({ tenantId: 'acme', chainedOnly: true })).map((e) => e.id)
    expect(ids.sort()).toEqual(['acme-1', 'acme-2', 'acme-3'])
    expect((await audit.trail({ tenantId: 'acme', chainedOnly: true, limit: 2 })).map((e) => e.id)).toEqual(['acme-3', 'acme-2'])
  })
})

describe('FA-020 — PrismaAuditStore never forwards an operator or an unvalidated limit', () => {
  it('rejects `{ not: … }` filters and a string limit before Prisma sees them', async () => {
    const { client, store, audit } = await seeded()
    const before = client.calls.length
    for (const bad of [{ tenantId: { not: 'zzz' } }, { actorId: { in: ['a'] } }, { event: { contains: 'x' } }, { tenantId: null }, { limit: '5' }, { limit: -1 }]) {
      await expect(store.query(bad as never), JSON.stringify(bad)).rejects.toThrow(TypeError)
      await expect(audit.trail(bad as never)).rejects.toThrow(TypeError)
    }
    expect(client.calls.length).toBe(before)
  })
})
