import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  Audit,
  AUDIT_ERASED,
  AUDIT_REDACTED_EVENT,
  AuditChainConflictError,
  AuditRedactionConflictError,
  type AuditEntry,
  type AuditOptions,
  type AuditRedactionWrite,
} from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { migrate, openAuditDatabase, SqliteAuditStore } from '../src/index.js'

const keyed: AuditOptions = { integrity: { mode: 'hash-chain', key: 'k'.repeat(32), keyId: 'k1' } }

const setup = (options: AuditOptions = keyed) => {
  const db = openAuditDatabase()
  const store = new SqliteAuditStore(db)
  return { db, store, audit: new Audit(store, undefined, undefined, options) }
}

/** The guard-trigger SQL exactly as the README documents it. */
const guardTriggers = (): string => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const block = /<!-- audit-sqlite:guard-triggers -->\s*```sql\n([\s\S]*?)```/.exec(readme)
  if (!block) throw new Error('guard-trigger snippet not found in README.md')
  return block[1]!
}

const order = { orderId: 'o-1', customer: { email: 'ana@example.com', name: 'Ana' } }

describe('SqliteAuditStore — erasure', () => {
  it('redacts in place, round-trips the marker, and verifies end-to-end', async () => {
    const { db, store, audit } = setup()
    const entry = await audit.record('order.placed', order)
    await audit.record('next')
    const { attestation } = await audit.redact(entry.id, { payload: ['customer.email'], reasonRef: 'DSR-7' })

    const row = db.prepare('SELECT payload, hash, redaction, redacted_by FROM audit_entries WHERE id = ?').get(entry.id) as Record<string, string>
    expect(row.payload).not.toContain('ana@example.com')
    expect(row.hash).toBe(entry.hash)
    expect(row.redacted_by).toBe(attestation!.id)
    expect(JSON.parse(row.redaction!)).toEqual({ ip: false, payload: ['customer.email'], userAgent: false })

    const stored = await store.get(entry.id)
    expect(stored!.redaction).toEqual({ attestationId: attestation!.id, payload: ['customer.email'], ip: false, userAgent: false })
    expect(stored!.payload).toEqual({ orderId: 'o-1', customer: { email: AUDIT_ERASED, name: 'Ana' } })
    expect(await store.get('missing')).toBeUndefined()
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })

    // A fresh Audit over the same file sees the same thing.
    expect(await new Audit(new SqliteAuditStore(db), undefined, undefined, keyed).verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it('redacts ip / userAgent and the whole payload', async () => {
    const db = openAuditDatabase()
    const audit = new Audit(new SqliteAuditStore(db), undefined, undefined, { ...keyed, requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }) })
    const entry = await audit.record('login', { email: 'a@b.co' })
    await audit.redact(entry.id, { payload: 'all', ip: true, userAgent: true })
    const row = db.prepare('SELECT payload, ip, user_agent FROM audit_entries WHERE id = ?').get(entry.id) as Record<string, unknown>
    expect(row).toEqual({ payload: JSON.stringify(AUDIT_ERASED), ip: null, user_agent: null })
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })

  it('detects tampering of a redacted row and of its marker columns', async () => {
    const { db, audit } = setup()
    const entry = await audit.record('order.placed', order)
    await audit.redact(entry.id, { payload: ['customer.email'] })

    db.prepare('UPDATE audit_entries SET payload = ? WHERE id = ?').run(JSON.stringify(order), entry.id)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch' })

    // Dropping the marker leaves an edited row under its original hash.
    db.prepare('UPDATE audit_entries SET redaction = NULL, redacted_by = NULL WHERE id = ?').run(entry.id)
    db.prepare('UPDATE audit_entries SET payload = ? WHERE id = ?').run(JSON.stringify({ ...order, customer: { email: AUDIT_ERASED, name: 'Ana' } }), entry.id)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'hash-mismatch' })

    // A half-set or unparsable marker fails closed rather than reading as unredacted.
    db.prepare("UPDATE audit_entries SET redaction = 'not json' WHERE id = ?").run(entry.id)
    expect(await audit.verify()).toMatchObject({ ok: false, reason: 'redaction-mismatch', detail: 'malformed redaction marker' })
  })

  it('migrates an existing database to the new columns', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE audit_entries (id TEXT PRIMARY KEY, source TEXT NOT NULL, event TEXT NOT NULL, payload TEXT,
      actor_id TEXT, tenant_id TEXT, request_id TEXT, at INTEGER NOT NULL)`)
    db.prepare("INSERT INTO audit_entries (id, source, event, payload, at) VALUES ('old', 'manual', 'x', '{\"email\":\"a@b.co\"}', 1)").run()
    migrate(db)
    migrate(db) // idempotent
    const columns = (db.prepare('PRAGMA table_info(audit_entries)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['redaction', 'redacted_by']))
    const store = new SqliteAuditStore(db)
    const audit = new Audit(store, undefined, undefined, keyed)
    // A legacy unchained row is redactable; its attestation starts the chain.
    const result = await audit.redact('old', { payload: ['email'], residual: 'none' })
    expect(result.residual).toBe('none')
    expect((await store.get('old'))!.payload).toEqual({ email: AUDIT_ERASED })
  })

  it('maps an expect mismatch to AuditRedactionConflictError and rolls back a seq conflict', async () => {
    const { db, store, audit } = setup()
    const entry = await audit.record('x', { email: 'a@b.co' })
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM audit_entries ORDER BY id').all())
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
    await expect(store.redact(write({ hash: entry.hash, redactedBy: 'someone' }))).rejects.toBeInstanceOf(AuditRedactionConflictError)
    // The UPDATE succeeds, then the attestation's seq is taken: the update must roll back.
    await expect(store.redact(write({ hash: entry.hash, redactedBy: undefined }))).rejects.toBeInstanceOf(AuditChainConflictError)
    // Any other insert failure (duplicate id) rolls back too.
    await expect(store.redact(write({ hash: entry.hash, redactedBy: undefined }, { ...attestation, id: entry.id, seq: 9 }))).rejects.toThrow(/UNIQUE/)
    expect(JSON.stringify(db.prepare('SELECT * FROM audit_entries ORDER BY id').all())).toBe(snapshot)
    // The connection is usable again after the rollbacks.
    expect((await audit.redact(entry.id, { payload: ['email'] })).changed).toBe(true)
  })

  it('two Audit instances racing on one file both apply, merged', async () => {
    const db = openAuditDatabase()
    const a = new Audit(new SqliteAuditStore(db), undefined, undefined, keyed)
    const b = new Audit(new SqliteAuditStore(db), undefined, undefined, keyed)
    const entry = await a.record('order.placed', order)
    await Promise.all([a.redact(entry.id, { payload: ['customer.email'] }), b.redact(entry.id, { payload: ['customer.name'] })])
    const stored = await new SqliteAuditStore(db).get(entry.id)
    expect(stored!.redaction!.payload).toEqual(['customer.email', 'customer.name'])
    expect(await a.verify()).toMatchObject({ ok: true, checked: 3, redacted: 1 })
  })

  it('get() rejects a non-string id', async () => {
    const { store } = setup()
    await expect(store.get({ not: 'x' } as unknown as string)).rejects.toThrow(TypeError)
  })
})

describe('README guard triggers', () => {
  it('abort a DELETE and a hash UPDATE, and let the attested redaction through', async () => {
    const { db, audit } = setup()
    db.exec(guardTriggers())
    const entry = await audit.record('order.placed', order)
    expect(() => db.prepare('DELETE FROM audit_entries WHERE id = ?').run(entry.id)).toThrow(/append-only/)
    expect(() => db.prepare("UPDATE audit_entries SET hash = 'x' WHERE id = ?").run(entry.id)).toThrow(/attested redaction/)
    expect(() => db.prepare("UPDATE audit_entries SET payload = '{}' WHERE id = ?").run(entry.id)).toThrow(/attested redaction/)
    const { changed } = await audit.redact(entry.id, { payload: ['customer.email'] })
    expect(changed).toBe(true)
    // Clearing the marker after the fact is refused too.
    expect(() => db.prepare('UPDATE audit_entries SET redacted_by = NULL WHERE id = ?').run(entry.id)).toThrow(/attested redaction/)
    expect(await audit.verify()).toMatchObject({ ok: true, redacted: 1 })
  })
})
