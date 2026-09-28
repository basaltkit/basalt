/**
 * Regression tests for FA-016 (rows outside the chain in a SQL store) and
 * FA-020 (query filters must be strings) against the SQLite store.
 */
import { Audit, AUDIT_CHAIN_GENESIS, type AuditEntry, computeAuditHash } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { openAuditDatabase, SqliteAuditStore } from '../src/index.js'

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
  const db = openAuditDatabase()
  const store = new SqliteAuditStore(db)
  for (const entry of chainOf('acme', 3)) await store.append(entry)
  const audit = new Audit(store, undefined, undefined, { integrity: 'hash-chain' })
  const insert = (id: string, chain: string | null, seq: number | null, at: number) =>
    db
      .prepare("INSERT INTO audit_entries (id, source, event, payload, tenant_id, at, chain, seq, prev_hash, hash) VALUES (?, 'manual', 'user:promoted', '{\"role\":\"admin\"}', 'acme', ?, ?, ?, 'zz', 'zz')")
      .run(id, at, chain, seq)
  return { db, store, audit, insert }
}

describe('FA-016 — SqliteAuditStore: rows outside the chain count as broken', () => {
  it('a row with chain = NULL but a seq is reported, whatever its `at`', async () => {
    const { audit, insert } = await seeded()
    insert('forged', null, 2, 1) // backdated before the chain began
    expect((await audit.trail({ tenantId: 'acme' })).map((e) => e.id)).toContain('forged')
    const v = await audit.verify({ tenantId: 'acme' })
    expect(v).toMatchObject({ ok: false, reason: 'unchained-entry', unverified: ['forged'], checked: 3 })
  })

  it('a row under a bogus chain name is reported by verify() and by verifyAll() as an unknown chain', async () => {
    const { audit, insert } = await seeded()
    insert('bogus-row', 'bogus', 1, 5000)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, unverified: ['bogus-row'] })
    const all = await audit.verifyAll()
    expect(all.ok).toBe(false)
    expect(all.chains.find((c) => c.tenantId === 'bogus')).toMatchObject({ ok: false, reason: 'unknown-chain' })
  })

  it('a seq-less row written after the chain began is reported; a legacy one is not', async () => {
    const { audit, insert } = await seeded()
    insert('legacy', null, null, 1)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: true, unchained: 1, unverified: [] })
    insert('late', null, null, 9999)
    expect(await audit.verify({ tenantId: 'acme' })).toMatchObject({ ok: false, unchained: 2, unverified: ['late'] })
    expect(await audit.verify({ tenantId: 'acme', legacyUntil: 0 })).toMatchObject({ ok: false, unverified: ['legacy', 'late'] })
  })

  it('trail({ chainedOnly: true }) only returns rows in their own tenant chain', async () => {
    const { audit, insert } = await seeded()
    insert('null-chain', null, 7, 5000)
    insert('bogus-chain', 't:globex', 8, 5001)
    insert('plain', null, null, 5002)
    const ids = (await audit.trail({ tenantId: 'acme', chainedOnly: true })).map((e) => e.id)
    expect(ids.sort()).toEqual(['acme-1', 'acme-2', 'acme-3'])
  })

  it('verify({ expectedHead }) detects a deleted tail', async () => {
    const { db, audit } = await seeded()
    const { head } = await audit.verify({ tenantId: 'acme' })
    db.prepare("DELETE FROM audit_entries WHERE id = 'acme-3'").run()
    expect((await audit.verify({ tenantId: 'acme' })).ok).toBe(true)
    expect(await audit.verify({ tenantId: 'acme', expectedHead: head! })).toMatchObject({ ok: false, reason: 'truncated' })
  })
})

describe('FA-020 — SqliteAuditStore validates every filter', () => {
  it('rejects operator objects and non-string filters when called directly', async () => {
    const { store } = await seeded()
    for (const bad of [{ tenantId: { not: 'zzz' } }, { actorId: 1 }, { event: ['x'] }, { since: 'yesterday' }, { limit: '5' }]) {
      await expect(store.query(bad as never), JSON.stringify(bad)).rejects.toThrow(TypeError)
    }
  })
})
