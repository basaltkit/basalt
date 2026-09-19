import { Audit, type AuditEntry } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { openAuditDatabase, SqliteAuditStore } from '../src/index.js'

const entry = (over: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'event' | 'at'>): AuditEntry => ({
  source: 'hook', payload: undefined, ...over,
})

async function seeded() {
  const store = new SqliteAuditStore(openAuditDatabase(':memory:'))
  await store.append(entry({ id: 'mine', event: 'auth:login', at: 1, tenantId: 'acme' }))
  await store.append(entry({ id: 'theirs', event: 'auth:login', at: 2, tenantId: 'globex', payload: { secret: 'Zulu' } }))
  return store
}

/** A limit smuggled in as SQL: true when the other tenant's payload starts with `ch`. */
const oracle = (ch: string) =>
  `(SELECT CASE WHEN substr((SELECT payload FROM audit_entries WHERE tenant_id = 'globex'), 12, 1) = '${ch}' THEN 1 ELSE 0 END) --`

describe('security · audit-sqlite never interpolates limit/offset into SQL (F51)', () => {
  it('the store binds LIMIT/OFFSET as parameters and rejects a non-integer limit', async () => {
    const store = await seeded()
    await expect(store.query({ tenantId: 'acme', limit: oracle('Z') as never })).rejects.toThrow(/limit/i)
    await expect(store.query({ tenantId: 'acme', limit: oracle('Q') as never })).rejects.toThrow(/limit/i)
  })

  it('Audit.trail() refuses an unvalidated limit forwarded from a request, closing the cross-tenant oracle', async () => {
    const audit = new Audit(await seeded())
    const read = (limit: unknown) =>
      audit.trail({ tenantId: 'acme', limit: limit as number })
    await expect(read(oracle('Z'))).rejects.toThrow(/limit/i)
    await expect(read('1 OFFSET 0')).rejects.toThrow(/limit/i)
    await expect(read(1.5)).rejects.toThrow(/limit/i)
    await expect(read(-1)).rejects.toThrow(/limit/i)
    await expect(read(Number.NaN)).rejects.toThrow(/limit/i)
    // A genuine integer limit keeps working and stays tenant-scoped.
    expect((await read(10)).map((e) => e.id)).toEqual(['mine'])
    expect(await read(0)).toEqual([])
  })

  it('a wildcard scan still pages with bound parameters', async () => {
    const store = await seeded()
    expect((await store.query({ tenantId: 'acme', event: 'auth:**', limit: 5 })).map((e) => e.id)).toEqual(['mine'])
  })
})
