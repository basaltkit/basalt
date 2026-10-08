import {
  Audit,
  AUDIT_ERASED,
  AUDIT_REDACTED_EVENT,
  AuditChainConflictError,
  AuditRedactionConflictError,
  AuditRedactionRefusedError,
  type AuditEntry,
  type AuditOptions,
  type AuditRedactionWrite,
} from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaAuditStore, type PrismaAuditClient } from '../src/index.js'
import { matches, type Where } from './prisma-where.js'

type Row = Record<string, unknown>

const LEGACY_COLUMNS = ['redaction', 'redactedBy', 'nonce']

/**
 * An in-memory stand-in for a generated client with the 2.1 `AuditEntry` model:
 * `@@unique([chain, seq])`, `findUnique`, `updateMany` and an interactive
 * `$transaction` that rolls every write back when the callback throws.
 */
function fakeClient(
  opts: { legacySchema?: boolean; withoutNonce?: boolean; withoutTransaction?: boolean; withoutFindUnique?: boolean } = {},
) {
  let rows: Row[] = []
  const unknownColumn = (data: Row) => {
    const missing = opts.legacySchema ? LEGACY_COLUMNS : opts.withoutNonce ? ['nonce'] : []
    const bad = Object.keys(data).find((k) => missing.includes(k))
    if (bad) throw new Error(`Unknown argument \`${bad}\``)
  }
  const delegate: PrismaAuditClient['auditEntry'] = {
    async create({ data }: { data: Row }) {
      unknownColumn(data)
      if (rows.some((r) => r['id'] === data['id'])) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002', meta: { target: ['id'] } })
      }
      if (data['seq'] != null && rows.some((r) => r['chain'] === data['chain'] && r['seq'] === data['seq'])) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`chain`,`seq`)'), {
          code: 'P2002',
          meta: { target: ['chain', 'seq'] },
        })
      }
      rows.push({ ...data })
      return data as never
    },
    async findMany(args: { where?: Where; orderBy?: unknown; take?: number }) {
      let out = rows.filter((r) => matches(r, args.where))
      const order = JSON.stringify(args.orderBy ?? '')
      if (order.includes('"seq":"desc"')) out = [...out].sort((a, b) => (b['seq'] as number) - (a['seq'] as number))
      else if (order.includes('"seq":"asc"')) out = [...out].sort((a, b) => (a['seq'] as number) - (b['seq'] as number))
      return (args.take === undefined ? out : out.slice(0, args.take)) as never
    },
    async count({ where }: { where?: Where }) {
      return rows.filter((r) => matches(r, where)).length
    },
    async updateMany({ where, data }: { where: Where; data: Row }) {
      unknownColumn(data)
      let count = 0
      rows = rows.map((r) => (matches(r, where) ? (count++, { ...r, ...data }) : r))
      return { count }
    },
  }
  if (!opts.withoutFindUnique) {
    delegate.findUnique = async ({ where }: { where: { id: string } }) => (rows.find((r) => r['id'] === where.id) ?? null) as never
  }
  const client: PrismaAuditClient & { rows: () => Row[]; transactions: number } = {
    rows: () => rows,
    transactions: 0,
    auditEntry: delegate,
  }
  if (!opts.withoutTransaction) {
    client.$transaction = async (fn: (tx: PrismaAuditClient) => Promise<unknown>) => {
      client.transactions++
      const snapshot = rows.map((r) => ({ ...r }))
      try {
        return await fn({ auditEntry: delegate })
      } catch (error) {
        rows = snapshot
        throw error
      }
    }
  }
  return client
}

const keyed: AuditOptions = { integrity: { mode: 'hash-chain', key: 'k'.repeat(32), keyId: 'k1' } }
const order = { orderId: 'o-1', customer: { email: 'ana@example.com', name: 'Ana' } }

describe('PrismaAuditStore — erasure', () => {
  it('redacts in one transaction, round-trips the marker and verifies', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const audit = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('order.placed', order)
    const { attestation } = await audit.redact(entry.id, { payload: ['customer.email'] })
    expect(client.transactions).toBe(1)

    const row = client.rows().find((r) => r['id'] === entry.id)!
    expect(row['payload']).not.toContain('ana@example.com')
    expect(row['hash']).toBe(entry.hash)
    expect(row['redactedBy']).toBe(attestation!.id)
    expect(row['redaction']).toBe('{"ip":false,"payload":["customer.email"],"userAgent":false}')
    expect((await store.get(entry.id))!.redaction).toEqual({ attestationId: attestation!.id, payload: ['customer.email'], ip: false, userAgent: false })
    expect(await store.get('missing')).toBeUndefined()
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2, redacted: 1 })
  })

  it('get() falls back to findMany, and refuses a non-string id', async () => {
    const client = fakeClient({ withoutFindUnique: true })
    const store = new PrismaAuditStore(client)
    await new Audit(store).record('x')
    const [row] = client.rows()
    expect((await store.get(row!['id'] as string))?.event).toBe('x')
    await expect(store.get({ not: 'x' } as unknown as string)).rejects.toThrow(TypeError)
  })

  it('maps conflicts and rolls back a seq race', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const audit = new Audit(store, undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const snapshot = JSON.stringify(client.rows())
    const attestation: AuditEntry = { id: 'att', source: 'manual', event: AUDIT_REDACTED_EVENT, payload: {}, at: 2, seq: 1, prevHash: '0', hash: 'h' }
    const write = (expect: AuditRedactionWrite['expect'], att = attestation): AuditRedactionWrite => ({
      id: entry.id,
      expect,
      payload: { email: AUDIT_ERASED },
      ip: undefined,
      userAgent: undefined,
      redaction: { attestationId: att.id, payload: ['email'], ip: false, userAgent: false },
      attestation: att,
    })
    await expect(store.redact(write({ hash: 'stale', redactedBy: undefined }))).rejects.toBeInstanceOf(AuditRedactionConflictError)
    await expect(store.redact(write({ hash: entry.hash, redactedBy: 'x' }))).rejects.toBeInstanceOf(AuditRedactionConflictError)
    await expect(store.redact(write({ hash: entry.hash, redactedBy: undefined }))).rejects.toBeInstanceOf(AuditChainConflictError)
    // A unique violation on another field is not a chain conflict.
    await expect(store.redact(write({ hash: entry.hash, redactedBy: undefined }, { ...attestation, id: entry.id, seq: 5 }))).rejects.toMatchObject({ code: 'P2002' })
    expect(JSON.stringify(client.rows())).toBe(snapshot)
  })

  it('a racing append is retried by Audit', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const audit = new Audit(store, undefined, undefined, keyed)
    const writer = new Audit(new PrismaAuditStore(client), undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const redact = store.redact.bind(store)
    let raced = false
    store.redact = async (w) => {
      if (!raced) {
        raced = true
        await writer.record('racer')
      }
      return redact(w)
    }
    const { attestation } = await audit.redact(entry.id, { payload: ['email'] })
    expect(attestation!.seq).toBe(3)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })
  })

  it("refuses ('unsupported-store') a client without $transaction / updateMany, writing nothing", async () => {
    const client = fakeClient({ withoutTransaction: true })
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    const error = await audit.redact(entry.id, { payload: ['email'] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuditRedactionRefusedError)
    expect(error).toMatchObject({ reason: 'unsupported-store', message: expect.stringMatching(/\$transaction/) })
    expect(client.rows()).toHaveLength(1)
  })

  it('an old-schema client without the new columns still appends and verifies', async () => {
    const client = fakeClient({ legacySchema: true })
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, keyed)
    await audit.record('a', { n: 1 })
    await audit.record('b', { n: 2 })
    expect(Object.keys(client.rows()[0]!)).not.toContain('redaction')
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2, redacted: 0 })
  })

  it('v3 (erasable): persists the nonce and clears it on redaction', async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client)
    const audit = new Audit(store, undefined, undefined, { integrity: { mode: 'hash-chain', key: 'k'.repeat(32), keyId: 'k1', erasable: true } })
    const entry = await audit.record('x', { email: 'a@b.co' })
    expect((await store.get(entry.id))!.nonce).toBe(entry.nonce)
    const result = await audit.redact(entry.id, { payload: ['email'], residual: 'none' })
    expect(result.residual).toBe('none')
    expect(client.rows().find((r) => r['id'] === entry.id)!['nonce']).toBeNull()
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 2, redacted: 1 })
  })

  it('v2 rows redact on a schema without the nonce column', async () => {
    const client = fakeClient({ withoutNonce: true })
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    expect((await audit.redact(entry.id, { payload: ['email'] })).changed).toBe(true)
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it('erasable on a schema without the nonce column fails loudly', async () => {
    const client = fakeClient({ withoutNonce: true })
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, { integrity: { mode: 'hash-chain', erasable: true } })
    await expect(audit.record('x')).rejects.toThrow(/Unknown argument `nonce`/)
  })

  it('a malformed marker fails closed', async () => {
    const client = fakeClient()
    const audit = new Audit(new PrismaAuditStore(client), undefined, undefined, keyed)
    const entry = await audit.record('x', { email: 'a@b.co' })
    await audit.redact(entry.id, { payload: ['email'] })
    client.rows().find((r) => r['id'] === entry.id)!['redaction'] = '{oops'
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', detail: 'malformed redaction marker' })
  })

  it("enforces the mysql column limits on the redaction write", async () => {
    const client = fakeClient()
    const store = new PrismaAuditStore(client, { columnLimits: { AuditEntry: { redactedBy: 8 } } })
    const write: AuditRedactionWrite = {
      id: 'e',
      expect: { hash: undefined, redactedBy: undefined },
      payload: null,
      ip: undefined,
      userAgent: undefined,
      redaction: { attestationId: 'a-very-long-attestation-id', payload: 'all', ip: false, userAgent: false },
      attestation: { id: 'a', source: 'manual', event: AUDIT_REDACTED_EVENT, payload: {}, at: 1 },
    }
    await expect(store.redact(write)).rejects.toBeInstanceOf(ColumnLengthError)
    expect(client.transactions).toBe(0)
  })
})
