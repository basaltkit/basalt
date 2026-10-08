import { runWithContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { Audit, auditChainKey, MemoryAuditStore } from '../src/index.js'

const chained = () => {
  const store = new MemoryAuditStore()
  return { store, audit: new Audit(store, undefined, () => true, { integrity: 'hash-chain' }) }
}

describe('audit.record(event, payload, scope) — attribution outside a request', () => {
  it('without a context, scope attributes the entry and it joins the tenant chain', async () => {
    const { store, audit } = chained()
    const entry = await audit.record('report.generated', { rows: 3 }, { tenantId: 'acme', actorId: 'job:nightly' })
    expect(entry).toMatchObject({ tenantId: 'acme', actorId: 'job:nightly', seq: 1, source: 'manual' })
    expect(await store.chainHead('acme')).toMatchObject({ seq: 1 })
    expect(await store.chainHead(undefined)).toBeUndefined()
    expect(auditChainKey(entry.tenantId)).toBe('t:acme')
    expect((await audit.verify({ tenantId: 'acme' })).ok).toBe(true)
    expect(await audit.trail({ tenantId: 'acme' })).toHaveLength(1)
  })

  it('without scope the behaviour is unchanged (system chain, no actor)', async () => {
    const { store, audit } = chained()
    const entry = await audit.record('job.ran')
    expect(entry.tenantId).toBeUndefined()
    expect(entry.actorId).toBeUndefined()
    expect(await store.chainHead(undefined)).toMatchObject({ seq: 1 })
  })

  it('inside a tenant context, the same tenant is accepted and a different one throws', async () => {
    const { audit } = chained()
    await runWithContext({ tenant: { id: 'a' } }, async () => {
      const entry = await audit.record('x', undefined, { tenantId: 'a' })
      expect(entry.tenantId).toBe('a')
      await expect(audit.record('x', undefined, { tenantId: 'b' })).rejects.toThrow(
        'audit.record: scope.tenantId cannot differ from the request tenant',
      )
    })
    expect((await audit.verify({ tenantId: 'b' })).checked).toBe(0)
  })

  it('a context user cannot be replaced by scope.actorId', async () => {
    const { audit } = chained()
    await runWithContext({ user: { id: 'u1' } }, async () => {
      expect((await audit.record('x', undefined, { actorId: 'u1' })).actorId).toBe('u1')
      await expect(audit.record('x', undefined, { actorId: 'u2' })).rejects.toThrow(TypeError)
    })
  })

  it('a scope may supply what the context lacks (tenant in context, actor from scope)', async () => {
    const { audit } = chained()
    const entry = await runWithContext({ tenant: { id: 'a' } }, () => audit.record('x', undefined, { actorId: 'cli' }))
    expect(entry).toMatchObject({ tenantId: 'a', actorId: 'cli' })
  })

  it('rejects invalid scope values', async () => {
    const { audit } = chained()
    for (const scope of [
      { tenantId: '' },
      { tenantId: 'a'.repeat(257) },
      { tenantId: 'a\nb' },
      { tenantId: 42 },
      { tenantId: { not: 'x' } },
      { actorId: '' },
      { actorId: ['u1'] },
    ]) {
      await expect(audit.record('x', undefined, scope as never)).rejects.toThrow(TypeError)
    }
    await expect(audit.record('x', undefined, 'acme' as never)).rejects.toThrow(TypeError)
    await expect(audit.record('x', undefined, null as never)).rejects.toThrow(TypeError)
  })

  it('works without integrity too', async () => {
    const audit = new Audit(new MemoryAuditStore())
    const entry = await audit.record('x', undefined, { tenantId: 't1' })
    expect(entry.tenantId).toBe('t1')
    expect(entry.seq).toBeUndefined()
  })
})
