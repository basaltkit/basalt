import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityRecord } from '@machize/activity'
import { afterAll, describe, expect, it } from 'vitest'
import { openActivityDatabase, SqliteActivityStore, sqliteActivityStore } from '../src/index.js'

const rec = (over: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'description' | 'at'>): ActivityRecord => ({
  log: 'default', ...over,
})

describe('SqliteActivityStore', () => {
  it('appends and queries newest-first with filters and limit', async () => {
    const store = new SqliteActivityStore(openActivityDatabase())
    await store.append(rec({ id: 'r1', description: 'created', at: 10, tenantId: 't1', causerId: 'u1', subjectType: 'project', subjectId: 'p1', properties: { to: 'draft' } }))
    await store.append(rec({ id: 'r2', description: 'published', at: 20, tenantId: 't1', causerId: 'u2', subjectType: 'project', subjectId: 'p1', log: 'project' }))
    await store.append(rec({ id: 'r3', description: 'other', at: 30, tenantId: 't2', causerId: 'u1' }))

    expect((await store.query({})).map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect((await store.query({ tenantId: 't1' })).map((r) => r.id)).toEqual(['r2', 'r1'])
    expect((await store.query({ log: 'project' })).map((r) => r.id)).toEqual(['r2'])
    expect((await store.query({ subjectType: 'project', subjectId: 'p1' })).map((r) => r.id)).toEqual(['r2', 'r1'])
    expect((await store.query({ causerId: 'u1' })).map((r) => r.id)).toEqual(['r3', 'r1'])
    expect((await store.query({ limit: 2 })).map((r) => r.id)).toEqual(['r3', 'r2'])

    const r1 = (await store.query({ tenantId: 't1' })).find((r) => r.id === 'r1')
    expect(r1?.properties).toEqual({ to: 'draft' })
    expect(r1?.subjectType).toBe('project')
    expect((await store.query({})).find((r) => r.id === 'r3')?.properties).toBeUndefined()
  })
})

describe('sqliteActivityStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-activity-'))
  const file = join(dir, 'activity.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for activityPlugin', () => {
    expect(sqliteActivityStore().store).toBeInstanceOf(SqliteActivityStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openActivityDatabase()
    const a = sqliteActivityStore(db)
    expect(a.db).toBe(db)
    await a.store.append(rec({ id: 'r1', description: 'x', at: 1 }))
    expect((await new SqliteActivityStore(db).query({})).length).toBe(1)
  })

  it('survives a process restart', async () => {
    const first = sqliteActivityStore(file)
    await first.store.append(rec({ id: 'r1', description: 'persist', at: 1, properties: { k: 1 } }))
    first.db.close()
    const second = sqliteActivityStore(file)
    const rows = await second.store.query({})
    expect(rows[0]?.description).toBe('persist')
    expect(rows[0]?.properties).toEqual({ k: 1 })
    second.db.close()
  })
})
