import { Audit, type AuditEntry, type AuditQuery } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import { openAuditDatabase, SqliteAuditStore } from '../src/index.js'

/**
 * `auditTenants()` lets `verifyAll()` reach tenants whose rows are all outside
 * a chain with one `SELECT DISTINCT`, instead of falling back to `query({})` —
 * a read of the whole trail.
 */
describe('SqliteAuditStore.auditTenants()', () => {
  it('returns every tenant with a row, chained or not, once — undefined for rows without a tenant', async () => {
    const store = new SqliteAuditStore(openAuditDatabase())
    expect(await store.auditTenants()).toEqual([])
    const row = (id: string, tenantId?: string): AuditEntry => ({ id, source: 'manual', event: 'e', at: 1, payload: {}, ...(tenantId ? { tenantId } : {}) })
    await store.append(row('1', 'acme'))
    await store.append(row('2', 'acme'))
    await store.append(row('3', 'globex'))
    await store.append(row('4'))
    const tenants = await store.auditTenants()
    expect(tenants).toHaveLength(3)
    expect(new Set(tenants)).toEqual(new Set(['acme', 'globex', undefined]))
  })

  it('verifyAll() finds a forged row of a chainless tenant without scanning the trail', async () => {
    const store = new SqliteAuditStore(openAuditDatabase())
    const audit = new Audit(store, undefined, undefined, { integrity: 'hash-chain' })
    await audit.record('system:boot') // integrity is on from here
    await store.append({ id: 'forged', source: 'manual', event: 'user:promoted', tenantId: 'victim', at: Date.now() + 5, payload: {} })

    const queries: AuditQuery[] = []
    const query = store.query.bind(store)
    store.query = (q: AuditQuery) => {
      queries.push(q)
      return query(q)
    }
    const all = await audit.verifyAll()
    expect(all.ok).toBe(false)
    expect(all.chains.find((c) => c.tenantId === 'victim')).toMatchObject({ ok: false, reason: 'unchained-entry', entryId: 'forged' })
    expect(queries).toEqual([]) // no full-trail fallback
  })
})
