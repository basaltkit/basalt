import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditEntry } from '@machize/audit'
import { afterAll, describe, expect, it } from 'vitest'
import { openAuditDatabase, SqliteAuditStore, sqliteAuditStore } from '../src/index.js'

const entry = (over: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'event' | 'at'>): AuditEntry => ({
  source: 'hook', payload: undefined, ...over,
})

describe('SqliteAuditStore', () => {
  it('appends and queries newest-first with filters, pattern and limit', async () => {
    const store = new SqliteAuditStore(openAuditDatabase())
    await store.append(entry({ id: 'a1', event: 'auth:login', at: 10, tenantId: 't1', actorId: 'u1', payload: { ip: '1' } }))
    await store.append(entry({ id: 'a2', event: 'auth:logout', at: 20, tenantId: 't1', actorId: 'u2' }))
    await store.append(entry({ id: 'a3', event: 'order:created', at: 30, tenantId: 't1', actorId: 'u1' }))
    await store.append(entry({ id: 'a4', event: 'auth:login', at: 40, tenantId: 't2', actorId: 'u1' }))

    // newest first
    expect((await store.query({})).map((e) => e.id)).toEqual(['a4', 'a3', 'a2', 'a1'])
    // payload round-trips; missing payload is undefined
    expect((await store.query({ tenantId: 't1', actorId: 'u1' })).find((e) => e.id === 'a1')?.payload).toEqual({ ip: '1' })
    expect((await store.query({})).find((e) => e.id === 'a2')?.payload).toBeUndefined()

    expect((await store.query({ tenantId: 't1' })).map((e) => e.id)).toEqual(['a3', 'a2', 'a1'])
    expect((await store.query({ actorId: 'u1' })).map((e) => e.id)).toEqual(['a4', 'a3', 'a1'])
    expect((await store.query({ since: 25 })).map((e) => e.id)).toEqual(['a4', 'a3'])
    expect((await store.query({ event: 'auth:**' })).map((e) => e.id)).toEqual(['a4', 'a2', 'a1'])
    expect((await store.query({ event: 'auth:login', tenantId: 't1' })).map((e) => e.id)).toEqual(['a1'])
    expect((await store.query({ limit: 2 })).map((e) => e.id)).toEqual(['a4', 'a3'])
    // limit counts only pattern-matched rows
    expect((await store.query({ event: 'auth:**', limit: 1 })).map((e) => e.id)).toEqual(['a4'])
  })
})

describe('sqliteAuditStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-audit-'))
  const file = join(dir, 'audit.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for auditPlugin', () => {
    expect(sqliteAuditStore().store).toBeInstanceOf(SqliteAuditStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openAuditDatabase()
    const a = sqliteAuditStore(db)
    expect(a.db).toBe(db)
    await a.store.append(entry({ id: 'a1', event: 'x', at: 1 }))
    expect((await new SqliteAuditStore(db).query({})).length).toBe(1)
  })

  it('survives a process restart', async () => {
    const first = sqliteAuditStore(file)
    await first.store.append(entry({ id: 'a1', event: 'auth:login', at: 1, payload: { k: 1 } }))
    first.db.close()
    const second = sqliteAuditStore(file)
    const rows = await second.store.query({})
    expect(rows[0]?.id).toBe('a1')
    expect(rows[0]?.payload).toEqual({ k: 1 })
    second.db.close()
  })
})
