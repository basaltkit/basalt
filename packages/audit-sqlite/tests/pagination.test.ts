import type { AuditEntry } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { SqliteAuditStore, openAuditDatabase } from '../src/index.js'

const entry = (over: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'event' | 'at'>): AuditEntry => ({
  source: 'hook', payload: undefined, ...over,
})

/** Wraps the database so every SQL string the store prepares is recorded. */
function spyStore(n: number) {
  const db = openAuditDatabase(':memory:')
  const sql: string[] = []
  const spied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver) as never
      return (text: string) => {
        sql.push(text)
        return target.prepare(text)
      }
    },
  })
  const store = new SqliteAuditStore(spied as never)
  for (let i = 0; i < n; i++) {
    void store.append(
      entry({ id: `a${String(i).padStart(5, '0')}`, event: i % 10 === 0 ? 'auth:login' : 'noise:tick', at: i, tenantId: 't1' }),
    )
  }
  sql.length = 0
  return { store, sql }
}

describe('F-5 · audit-sqlite pushes the limit down', () => {
  it('a limited query emits a LIMIT clause instead of SELECT-everything', async () => {
    const { store, sql } = spyStore(2_000)

    const page = await store.query({ tenantId: 't1', limit: 50 })

    expect(page).toHaveLength(50)
    expect(sql.every((s) => s.includes('LIMIT'))).toBe(true)
  })

  it('an exact event name is pushed into the WHERE clause', async () => {
    const { store, sql } = spyStore(2_000)

    const page = await store.query({ tenantId: 't1', event: 'auth:login', limit: 10 })

    expect(page.map((e) => e.event)).toEqual(Array(10).fill('auth:login'))
    expect(sql.some((s) => s.includes('event = ?'))).toBe(true)
  })

  it('a wildcard event scans in bounded pages', async () => {
    const { store, sql } = spyStore(2_000)

    const page = await store.query({ tenantId: 't1', event: 'auth:**', limit: 5 })

    expect(page.map((e) => e.event)).toEqual(Array(5).fill('auth:login'))
    expect(sql.every((s) => /LIMIT \d+ OFFSET \d+/.test(s))).toBe(true)
  })

  it('a `.`-separated pattern is NOT pushed down (`.` and `:` are interchangeable)', async () => {
    const { store, sql } = spyStore(100)

    const page = await store.query({ tenantId: 't1', event: 'auth.login' })

    expect(page).toHaveLength(10)
    expect(sql.some((s) => s.includes('event = ?'))).toBe(false)
  })

  it('still returns everything matched when no limit is given', async () => {
    const { store } = spyStore(300)
    expect(await store.query({ tenantId: 't1', event: 'auth:**' })).toHaveLength(30)
  })
})
