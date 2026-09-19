import { DatabaseSync } from 'node:sqlite'
import { Audit, AUDIT_CHAIN_GENESIS, AuditChainConflictError, type AuditEntry, computeAuditHash } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { migrate, openAuditDatabase, SqliteAuditStore } from '../src/index.js'

const chained = (db: DatabaseSync) => new Audit(new SqliteAuditStore(db), undefined, undefined, { integrity: 'hash-chain' })

/**
 * A valid chain for `tenantId`, built exactly as `Audit` links entries. (This
 * package does not depend on @basaltkit/core, so tests cannot open a tenant
 * context; tenant chains are appended through the store instead.)
 */
const chainOf = (tenantId: string, count: number, startSeq = 1, prevHash = AUDIT_CHAIN_GENESIS): AuditEntry[] => {
  let prev = prevHash
  return Array.from({ length: count }, (_, i) => {
    const linked: AuditEntry = {
      id: `${tenantId}-${startSeq + i}`, source: 'manual', event: 'doc.edit', payload: { i, nested: { b: 1, a: [1, { z: 1, y: 2 }] } },
      tenantId, actorId: 'u1', at: 1000 + i, seq: startSeq + i, prevHash: prev,
    }
    const entry = { ...linked, hash: computeAuditHash(linked) }
    prev = entry.hash
    return entry
  })
}

const seeded = async (count = 5) => {
  const db = openAuditDatabase()
  const store = new SqliteAuditStore(db)
  for (const entry of chainOf('acme', count)) await store.append(entry)
  return { db, audit: chained(db) }
}

describe('SqliteAuditStore — hash chain', () => {
  it('persists seq/prevHash/hash and request fields and verifies', async () => {
    const db = openAuditDatabase()
    const audit = new Audit(new SqliteAuditStore(db), undefined, undefined, {
      integrity: 'hash-chain',
      requestContext: () => ({ ip: '203.0.113.9', userAgent: 'curl/8' }),
    })
    const a = await audit.record('x', { nested: { b: 1, a: [1, { z: 1, y: 2 }] }, dropped: undefined })
    const [row] = await new SqliteAuditStore(db).query({})
    expect(row).toMatchObject({ seq: 1, prevHash: a.prevHash, hash: a.hash, ip: '203.0.113.9', userAgent: 'curl/8' })
    // the hash recomputed from the persisted row matches
    expect(computeAuditHash(row!)).toBe(a.hash)
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 1 })
    // tenant chains written through the store verify too
    for (const entry of chainOf('acme', 3)) await new SqliteAuditStore(db).append(entry)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 3 })
  })

  it('detects an UPDATE of the payload', async () => {
    const { db, audit } = await seeded()
    db.prepare("UPDATE audit_entries SET payload = '{\"i\":42}' WHERE seq = 3").run()
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 3, reason: 'hash-mismatch' })
  })

  it('detects a DELETE', async () => {
    const { db, audit } = await seeded()
    db.prepare('DELETE FROM audit_entries WHERE seq = 2').run()
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2, reason: 'sequence-gap' })
  })

  it('detects reordering (seq values swapped)', async () => {
    const { db, audit } = await seeded()
    db.exec('UPDATE audit_entries SET seq = -1 WHERE seq = 2; UPDATE audit_entries SET seq = 2 WHERE seq = 3; UPDATE audit_entries SET seq = 3 WHERE seq = -1')
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 2 })
  })

  it('detects a forged row appended with a bogus hash', async () => {
    const { db, audit } = await seeded()
    db.prepare(
      `INSERT INTO audit_entries (id, source, event, payload, tenant_id, at, chain, seq, prev_hash, hash)
       VALUES ('forged', 'manual', 'x', NULL, 'acme', 1, 't:acme', 6, ?, ?)`,
    ).run('f'.repeat(64), 'e'.repeat(64))
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, firstBrokenAt: 6, reason: 'prev-hash-mismatch', checked: 5 })
  })

  it('the (chain, seq) unique index rejects a fork with AuditChainConflictError', async () => {
    const { db } = await seeded(1)
    const store = new SqliteAuditStore(db)
    const [row] = await store.query({})
    await expect(store.append({ ...row!, id: 'fork' })).rejects.toBeInstanceOf(AuditChainConflictError)
    // the system chain is protected too (tenant_id NULL would not be, hence the chain column)
    const sys = await chained(db).record('sys')
    await expect(store.append({ ...sys, id: 'fork2' })).rejects.toBeInstanceOf(AuditChainConflictError)
  })

  it('parallel appends from two replicas (two Audit instances, one database) keep one valid chain', async () => {
    const db = openAuditDatabase()
    const replicaA = chained(db)
    const replicaB = chained(db)
    const entries = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? replicaA : replicaB).record('n', { i })))
    expect(new Set(entries.map((e) => e.seq)).size).toBe(60)
    expect(await replicaB.verify()).toMatchObject({ ok: true, checked: 60 })
  })

  it('keeps tenants independent', async () => {
    const db = openAuditDatabase()
    const store = new SqliteAuditStore(db)
    for (const entry of [...chainOf('acme', 2), ...chainOf('globex', 2)]) await store.append(entry)
    const audit = chained(db)
    // same seq in two chains is fine; a tenant id cannot collide with the system chain
    await store.append(chainOf('@system', 1)[0]!)
    expect((await audit.verifyAll()).chains.map((c) => c.tenantId)).toEqual([undefined, '@system', 'acme', 'globex'])
    db.prepare("UPDATE audit_entries SET event = 'y' WHERE tenant_id = 'acme'").run()
    expect((await audit.verify({ tenantId: 'acme' })).ok).toBe(false)
    expect((await audit.verify({ tenantId: 'globex' })).ok).toBe(true)
  })

  it('migrates a pre-integrity database and reports its rows as unchained, not broken', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE audit_entries (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, event TEXT NOT NULL, payload TEXT,
        actor_id TEXT, tenant_id TEXT, request_id TEXT, at INTEGER NOT NULL
      );
      INSERT INTO audit_entries VALUES ('old1', 'hook', 'auth:login', NULL, 'u1', 'acme', NULL, 1);
      INSERT INTO audit_entries VALUES ('old2', 'hook', 'auth:login', NULL, 'u1', 'acme', NULL, 2);
    `)
    migrate(db)
    migrate(db) // idempotent
    const audit = chained(db)
    await new SqliteAuditStore(db).append(chainOf('acme', 1)[0]!)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, checked: 1, unchained: 2 })
    // a system-chain record through Audit works on the migrated table
    await audit.record('new')
    expect(await audit.verify()).toMatchObject({ ok: true, checked: 1, unchained: 0 })
    const old = (await new SqliteAuditStore(db).query({})).find((e) => e.id === 'old1')
    expect(old?.seq).toBeUndefined()
    expect(old?.hash).toBeUndefined()
  })
})
