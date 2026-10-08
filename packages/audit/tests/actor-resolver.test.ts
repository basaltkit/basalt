import { createApp, runWithContext, type RequestContext } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { AUDIT, Audit, auditPlugin, MemoryAuditStore, type AuditActorResolver } from '../src/index.js'

/**
 * BK-083 (e): the `actor` option attributes non-human callers (a service API
 * key) in the app's own id format. Opt-in: the default stays `ctx().user?.id`.
 */

/** A service key request as @basaltkit/auth leaves it: ctx().apiKey, no ctx().user. */
const serviceKeyContext = (): RequestContext => ({ apiKey: { id: 'k1', scopes: ['sync'], serviceId: 'erp' } }) as RequestContext

const svcActor: AuditActorResolver = (context) => {
  const user = context?.['user'] as { id?: string } | undefined
  const apiKey = context?.['apiKey'] as { serviceId?: string } | undefined
  return user?.id ?? (apiKey?.serviceId !== undefined ? `svc:${apiKey.serviceId}` : undefined)
}

const chained = (actor?: AuditActorResolver) => {
  const store = new MemoryAuditStore()
  return { store, audit: new Audit(store, undefined, () => false, { integrity: 'hash-chain', ...(actor ? { actor } : {}) }) }
}

describe('Audit actor resolver (BK-083 e)', () => {
  it('default: unchanged — a userless service-key request records no actor, scope.actorId may supply one', async () => {
    const { audit } = chained()
    await runWithContext(serviceKeyContext(), async () => {
      expect((await audit.record('sync.ran')).actorId).toBeUndefined()
      expect((await audit.record('sync.ran', undefined, { actorId: 'svc:erp' })).actorId).toBe('svc:erp')
    })
    await runWithContext({ user: { id: 'u1' } } as RequestContext, async () => {
      expect((await audit.record('x')).actorId).toBe('u1')
    })
  })

  it('with the resolver, a service-key request records the app-formatted actor', async () => {
    const { audit } = chained(svcActor)
    const entry = await runWithContext(serviceKeyContext(), () => audit.record('sync.ran', { rows: 3 }))
    expect(entry.actorId).toBe('svc:erp')
    // A user still wins.
    const byUser = await runWithContext({ user: { id: 'u1' } } as RequestContext, () => audit.record('x'))
    expect(byUser.actorId).toBe('u1')
  })

  it('the resolved actor is the request actor: a differing scope.actorId throws', async () => {
    const { audit } = chained(svcActor)
    await runWithContext(serviceKeyContext(), async () => {
      expect((await audit.record('x', undefined, { actorId: 'svc:erp' })).actorId).toBe('svc:erp')
      await expect(audit.record('x', undefined, { actorId: 'svc:billing' })).rejects.toThrow(TypeError)
    })
  })

  it('hook capture records the resolved actor too', async () => {
    const app = await createApp({ plugins: [auditPlugin({ actor: svcActor, hooks: ['sync:**'], events: [] })] }).boot()
    const hooks = app.hooks as unknown as { emit(hook: string, payload: unknown): Promise<void> }
    await runWithContext(serviceKeyContext(), () => hooks.emit('sync:done', {}))
    const [entry] = await app.container.get(AUDIT).trail({})
    expect(entry).toMatchObject({ event: 'sync:done', actorId: 'svc:erp' })
    await app.shutdown()
  })

  it('the chain still verifies', async () => {
    const { audit } = chained(svcActor)
    await runWithContext(serviceKeyContext(), () => audit.record('a'))
    await audit.record('b')
    expect((await audit.verify()).ok).toBe(true)
  })

  it('refuses a resolver that is not a function, or that returns an invalid id', async () => {
    expect(() => new Audit(new MemoryAuditStore(), undefined, () => false, { actor: 'svc' as never })).toThrow(TypeError)
    const bad = new Audit(new MemoryAuditStore(), undefined, () => false, { actor: () => '' })
    await expect(bad.record('x')).rejects.toThrow(/actor resolver/)
    const multiline = new Audit(new MemoryAuditStore(), undefined, () => false, { actor: () => 'a\nb' })
    await expect(multiline.record('x')).rejects.toThrow(/actor resolver/)
  })
})
