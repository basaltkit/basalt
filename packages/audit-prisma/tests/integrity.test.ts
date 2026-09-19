import { Audit, AUDIT_CHAIN_GENESIS, AuditChainConflictError, type AuditEntry, computeAuditHash } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { PrismaAuditStore, type PrismaAuditClient } from '../src/index.js'

interface Row {
  id: string; source: string; event: string; payload: string | null
  actorId: string | null; tenantId: string | null; requestId: string | null; at: Date
  chain?: string | null; seq?: number | null; prevHash?: string | null; hash?: string | null
  ip?: string | null; userAgent?: string | null
}

type Where = { chain?: string | { not: null }; seq?: { gte?: number; lte?: number; not?: null } | null; tenantId?: string | null }

/** An in-memory stand-in for a generated client with the 1.2 `AuditEntry` model (incl. `@@unique([chain, seq])`). */
function fakeClient(opts: { legacySchema?: boolean } = {}) {
  const rows: Row[] = []
  const match = (r: Row, where: Where = {}) =>
    (where.chain === undefined ||
      (typeof where.chain === 'string' ? r.chain === where.chain : r.chain != null)) &&
    (where.tenantId === undefined || (r.tenantId ?? null) === where.tenantId) &&
    (where.seq === undefined ||
      (where.seq === null
        ? r.seq == null
        : r.seq != null && (where.seq.gte === undefined || r.seq >= where.seq.gte) && (where.seq.lte === undefined || r.seq <= where.seq.lte)))
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
        if (args.distinct?.includes('chain')) out = out.filter((r, i) => out.findIndex((o) => o.chain === r.chain) === i)
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
