import { Audit, AUDIT_CHAIN_GENESIS, AuditChainConflictError, type AuditEntry, computeAuditHash } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { PrismaAuditStore, type PrismaAuditClient } from '../src/index.js'
import { matches, type Where } from './prisma-where.js'

interface Row {
  id: string; source: string; event: string; payload: string | null
  actorId: string | null; tenantId: string | null; requestId: string | null; at: Date
  chain?: string | null; seq?: number | null; prevHash?: string | null; hash?: string | null
  ip?: string | null; userAgent?: string | null
}

/** An in-memory stand-in for a generated client with the 1.2 `AuditEntry` model (incl. `@@unique([chain, seq])`). */
function fakeClient(opts: { legacySchema?: boolean } = {}) {
  const rows: Row[] = []
  const match = (r: Row, where?: Where) => matches(r, where)
  const client: PrismaAuditClient & { rows: Row[]; creates: Array<Record<string, unknown>> } = {
    rows,
    creates: [],
    auditEntry: {
      async create({ data }: { data: Row }) {
        client.creates.push(data as unknown as Record<string, unknown>)
        if (opts.legacySchema && Object.keys(data).some((k) => ['chain', 'seq', 'prevHash', 'hash', 'ip', 'userAgent'].includes(k))) {
          throw new Error('Unknown argument `seq`')
        }
        if (data.seq != null && rows.some((r) => r.chain === data.chain && r.seq === data.seq)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`chain`,`seq`)'), {
            code: 'P2002',
            meta: { target: ['chain', 'seq'] },
          })
        }
        rows.push({ ...data })
        return data
      },
      async findMany(args: { where?: Where; orderBy?: unknown; take?: number; distinct?: string[] }) {
        let out = rows.filter((r) => match(r, args.where))
        const order = JSON.stringify(args.orderBy ?? '')
        if (order.includes('"seq":"desc"')) out = [...out].sort((a, b) => b.seq! - a.seq!)
        else if (order.includes('"seq":"asc"')) out = [...out].sort((a, b) => a.seq! - b.seq!)
        for (const col of args.distinct ?? []) {
          const key = col as keyof Row
          out = out.filter((r, i) => out.findIndex((o) => o[key] === r[key]) === i)
        }
        return args.take === undefined ? out : out.slice(0, args.take)
      },
      async count({ where }: { where?: Where }) {
        return rows.filter((r) => match(r, where)).length
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

const chained = (client: PrismaAuditClient) => new Audit(new PrismaAuditStore(client), undefined, undefined, { integrity: 'hash-chain' })

describe('PrismaAuditStore — hash chain', () => {
  it('writes chain/seq/prevHash/hash + ip/userAgent and verifies after a round-trip', async () => {
    const client = fakeClient()
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, {
      integrity: 'hash-chain',
      requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }),
    })
    const a = await audit.record('x', { b: 1, a: 2 })
    const b = await audit.record('y')
    expect(client.rows[0]).toMatchObject({ chain: '@system', seq: 1, prevHash: AUDIT_CHAIN_GENESIS, hash: a.hash, ip: '203.0.113.9', userAgent: 'curl/8' })
    expect(b.prevHash).toBe(a.hash)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2 })
  })

  it('writes exactly the legacy columns when integrity and request fields are off (no migration needed)', async () => {
    const client = fakeClient({ legacySchema: true })
    const store = new PrismaAuditStore(client)
    await new Audit(store).record('x', { k: 1 })
    expect(Object.keys(client.creates[0]!).sort()).toEqual(['actorId', 'at', 'event', 'id', 'payload', 'requestId', 'source', 'tenantId'])
    expect((await store.query({}))[0]?.seq).toBeUndefined()
  })

  it('maps a P2002 on (chain, seq) to AuditChainConflictError and two replicas never fork', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const [first] = chainOf('acme', 1)
    await store.append(first!)
    await expect(store.append({ ...first!, id: 'fork' })).rejects.toBeInstanceOf(AuditChainConflictError)

    const replicaA = chained(client)
    const replicaB = chained(client)
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? replicaA : replicaB).record('n', { i })))
    expect(await replicaA.verify()).toMatchObject({ ok: true, checked: 30 })
  })

  it('does not treat an unrelated P2002 (e.g. primary key) as a chain conflict', async () => {
    const client = fakeClient()
    client.auditEntry.create = async () => {
      throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002', meta: { target: ['id'] } })
    }
    await expect(new PrismaAuditStore(client).append(chainOf('acme', 1)[0]!)).rejects.not.toBeInstanceOf(AuditChainConflictError)
  })

  it('detects tampering, keeps tenants independent and reports legacy rows as unchained', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    await store.append({ id: 'legacy', source: 'hook', event: 'old', payload: undefined, tenantId: 'acme', at: 1 })
    for (const entry of [...chainOf('acme', 4), ...chainOf('globex', 2)]) await store.append(entry)
    const audit = chained(client)

    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 4, unchained: 1 })
    expect((await audit.verifyAll()).chains.map((c) => [c.tenantId, c.ok])).toEqual([[undefined, true], ['acme', true], ['globex', true]])

    const row = client.rows.find((r) => r.chain === 't:acme' && r.seq === 2)!
    row.payload = '{"i":99}'
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2, reason: 'hash-mismatch' })
    expect((await audit.verify({ tenantId: 'globex' })).ok).toBe(true)

    client.rows.splice(client.rows.indexOf(row), 1)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2, reason: 'sequence-gap' })
  })
})

describe('PrismaAuditStore.auditTenants()', () => {
  it('returns every tenant with a row, chained or not, once — undefined for rows without a tenant', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    expect(await store.auditTenants()).toEqual([])
    for (const entry of chainOf('acme', 2)) await store.append(entry)
    await store.append({ id: 'g', source: 'manual', event: 'e', tenantId: 'globex', at: 1, payload: {} })
    await store.append({ id: 's', source: 'manual', event: 'e', at: 1, payload: {} })
    const tenants = await store.auditTenants()
    expect(tenants).toHaveLength(3)
    expect(new Set(tenants)).toEqual(new Set(['acme', 'globex', undefined]))
  })

  it('asks the database for DISTINCT tenantId, selecting only that column', async () => {
    const client = fakeClient()
    const calls: unknown[] = []
    const findMany = client.auditEntry.findMany.bind(client.auditEntry)
    client.auditEntry.findMany = (args: never) => {
      calls.push(args)
      return findMany(args)
    }
    await new PrismaAuditStore(client).auditTenants()
    expect(calls).toEqual([{ distinct: ['tenantId'], select: { tenantId: true } }])
  })

  it('verifyAll() finds a forged row of a chainless tenant without scanning the trail', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const audit = chained(client)
    await audit.record('system:boot') // integrity is on from here
    await store.append({ id: 'forged', source: 'manual', event: 'user:promoted', tenantId: 'victim', at: Date.now() + 5, payload: {} })
    let scans = 0
    const query = store.query.bind(store)
    // `verifyAll()` must not fall back to query({}) — a read of the whole trail.
    const spied = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      query: (q: never) => {
        scans++
        return query(q)
      },
    }) as PrismaAuditStore
    const all = await new Audit(spied, undefined, undefined, { integrity: 'hash-chain' }).verifyAll()
    expect(all.chains.find((c) => c.tenantId === 'victim')).toMatchObject({ ok: false, reason: 'unchained-entry', entryId: 'forged' })
    expect(all.ok).toBe(false)
    expect(scans).toBe(0)
  })
})
