import { describe, expect, it } from 'vitest'
import { createApp, runWithContext, type RequestContext } from '@basaltkit/core'
import { isRouteVisible, route } from '@basaltkit/http'
import { MemoryAccessStore, definePolicy, permissionsPlugin } from '../src/index.js'

/**
 * `meta.can` visibility — the side-effect-free twin of the `can` guard that
 * `tools/list` of @basaltkit/mcp consults (over-the-wire coverage on every
 * adapter lives in packages/mcp/tests/permissions-visibility.test.ts).
 */
describe('permissionsPlugin · http:route-visibility for meta.can', () => {
  async function boot() {
    const store = new MemoryAccessStore()
    const emitted: string[] = []
    let policyCalls = 0
    const policy = definePolicy<{ ownerId: string }>('projects', {
      update: (user, project) => {
        policyCalls++
        return project.ownerId === user.id
      },
    })
    await store.grantToRole('editor', ['projects:update'], 'acme')
    await store.assignRole('ed', 'editor', 'acme')
    const app = await createApp({ plugins: [permissionsPlugin({ store, policies: [policy] })] }).boot()
    app.hooks.onAny((name) => {
      emitted.push(String(name))
    })
    const visible = (r: Parameters<typeof isRouteVisible>[0], user?: string, tenant?: string) => {
      const context = {
        ...(user ? { user: { id: user } } : {}),
        ...(tenant ? { tenant: { id: tenant } } : {}),
        container: app.container,
      } as unknown as RequestContext
      return runWithContext(context, () => isRouteVisible(r, context as Record<string, unknown>, app.container))
    }
    return { app, visible, emitted, policyCalls: () => policyCalls }
  }

  const update = route({ method: 'PUT', url: '/projects/:id', meta: { can: 'projects:update' }, handler: () => ({}) })
  const open = route({ method: 'GET', url: '/open', handler: () => ({}) })

  it('answers with the guard’s RBAC question, in the caller’s tenant scope', async () => {
    const { app, visible } = await boot()
    expect(await visible(update, 'ed', 'acme')).toBe(true)
    expect(await visible(update, 'ed', 'globex')).toBe(false) // the grant is acme's only
    expect(await visible(update, 'stranger', 'acme')).toBe(false)
    expect(await visible(update)).toBe(false) // no user: the guard would 401
    expect(await visible(open)).toBe(true) // no meta.can: no objection
    await app.shutdown()
  })

  it('never runs a policy nor emits a hook (no permission:denied audit on a listing)', async () => {
    const { app, visible, emitted, policyCalls } = await boot()
    await visible(update, 'stranger', 'acme')
    await visible(update, 'ed', 'acme')
    await visible(update)
    // The guard never passes a resource, so policies never decide `meta.can` —
    // a resource-level check inside the handler is invisible to the listing.
    expect(policyCalls()).toBe(0)
    expect(emitted).toEqual([])
    await app.shutdown()
  })

  it('hides a route whose meta.can is unenforceable (the guard refuses every call)', async () => {
    const { app, visible } = await boot()
    for (const can of [true, '', [], ['projects:update', 42]]) {
      const bad = route({ method: 'GET', url: '/bad', meta: { can: can as never }, handler: () => ({}) })
      expect(await visible(bad, 'ed', 'acme')).toBe(false)
    }
    await app.shutdown()
  })
})
