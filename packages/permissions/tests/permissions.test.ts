import { describe, expect, it } from 'vitest'
import { createApp, ctx, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route, type RequestEnricher } from '@basaltkit/fastify'
import {
  definePolicy,
  Gate,
  GATE,
  MemoryAccessStore,
  PermissionDeniedError,
  permissionMatches,
  permissionsPlugin,
} from '../src/index.js'

describe('permissionMatches', () => {
  it('exact, wildcard segment and global wildcard', () => {
    expect(permissionMatches('projects:delete', 'projects:delete')).toBe(true)
    expect(permissionMatches('projects:*', 'projects:delete')).toBe(true)
    expect(permissionMatches('*', 'anything:at:all')).toBe(true)
    expect(permissionMatches('projects:*', 'billing:read')).toBe(false)
    expect(permissionMatches('projects:*', 'projects:sub:deep')).toBe(false)
  })
})

const setupGate = async () => {
  const store = new MemoryAccessStore()
  await store.grantToRole('admin', ['projects:*', 'billing:read'], 'global')
  await store.assignRole('u1', 'admin', 'global')
  await store.grantToUser('u2', ['projects:read'], 'acme')
  const gate = new Gate({ store, superAdmin: (user) => user['owner'] === true })
  return { store, gate }
}

describe('Gate', () => {
  it('grants via role permissions with wildcards', async () => {
    const { gate } = await setupGate()
    expect(await gate.can({ id: 'u1' }, 'projects:delete')).toBe(true)
    expect(await gate.can({ id: 'u1' }, 'billing:read')).toBe(true)
    expect(await gate.can({ id: 'u1' }, 'billing:write')).toBe(false)
    expect(await gate.hasRole({ id: 'u1' }, 'admin')).toBe(true)
  })

  it('tenant scoping: grants in one tenant do not leak to another', async () => {
    const { gate } = await setupGate()
    const inTenant = (tenantId: string, fn: () => Promise<boolean>) =>
      runWithContext({ tenant: { id: tenantId } }, fn)

    expect(await inTenant('acme', () => gate.can({ id: 'u2' }, 'projects:read'))).toBe(true)
    expect(await inTenant('globex', () => gate.can({ id: 'u2' }, 'projects:read'))).toBe(false)
    // global grants apply inside any tenant
    expect(await inTenant('acme', () => gate.can({ id: 'u1' }, 'projects:read'))).toBe(true)
  })

  it('super admin short-circuits everything', async () => {
    const { gate } = await setupGate()
    expect(await gate.can({ id: 'nobody', owner: true }, 'anything:whatever')).toBe(true)
    expect(await gate.hasRole({ id: 'nobody', owner: true }, 'any-role')).toBe(true)
  })

  it('policies decide when a resource is given', async () => {
    const { gate } = await setupGate()
    gate.register(
      definePolicy<{ ownerId: string }>('project', {
        update: (user, project) => project.ownerId === user.id,
      }) as never,
    )

    expect(await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'u9' })).toBe(true)
    expect(await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'other' })).toBe(false)
    await expect(
      gate.authorize({ id: 'u9' }, 'project:update', { ownerId: 'other' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})

describe('permissionsPlugin + fastify guard (end to end)', () => {
  const routes = [
    route({
      method: 'DELETE',
      url: '/projects/:id',
      meta: { can: 'projects:delete' },
      async handler() {
        const user = ctx().user as { id: string } | undefined
        return { deleted: true, by: user?.id }
      },
    }),
  ]

  /** Test-only authentication: trusts the x-user-id header. */
  const fakeAuthPlugin = definePlugin({
    name: 'fake-auth',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        const userId = request.headers['x-user-id']
        if (typeof userId === 'string') context.user = { id: userId, email: `${userId}@x.dev` }
      }
      ensureMetadata(container).add('http:enrichers', enricher)
    },
  })

  const boot = async () => {
    const store = new MemoryAccessStore()
    await store.grantToUser('u-allowed', ['projects:delete'], 'global')
    const app = await createApp({
      plugins: [fakeAuthPlugin, permissionsPlugin({ store }), fastifyPlugin({ routes })],
    }).boot()
    return { app, server: app.container.get(FASTIFY) }
  }

  it('403 without the permission, 401 anonymous, 200 with it', async () => {
    const { app, server } = await boot()

    const anonymous = await server.inject({ method: 'DELETE', url: '/projects/p1' })
    expect(anonymous.statusCode).toBe(401)

    const denied = await server.inject({
      method: 'DELETE',
      url: '/projects/p1',
      headers: { 'x-user-id': 'u-denied' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('PERMISSION_DENIED')

    const allowed = await server.inject({
      method: 'DELETE',
      url: '/projects/p1',
      headers: { 'x-user-id': 'u-allowed' },
    })
    expect(allowed.json()).toEqual({ deleted: true, by: 'u-allowed' })

    expect(app.container.get(GATE)).toBeInstanceOf(Gate)
    await app.shutdown()
  })
})
