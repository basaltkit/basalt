import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { route, type RequestEnricher } from '@basaltkit/http'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryAccessStore, permissionsPlugin } from '../src/index.js'

/**
 * A9 · a permission that serves the portal opened the internal route too.
 *
 * `meta.can` is pure RBAC with no notion of surface. `matter:read` is a
 * capability; it does not distinguish "read my own case in the portal" from
 * "read the case with the litigation strategy inside it". An authenticated
 * client received 200 on `GET /matters` with their own case's strategy in the
 * body — found by hand, not by any test.
 *
 * The critical rule is the default: a route with **no** audience must be
 * unreachable for a confined role. Marking the exception rather than the rule
 * is precisely the mistake that produced the leak.
 */

/** Test-only authentication: trusts the x-user-id header. */
const fakeAuth = definePlugin({
  name: 'fake-auth',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const userId = request.headers['x-user-id']
      if (typeof userId === 'string') context.user = { id: userId }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const routes = [
  // Declares no audience at all — the case that matters.
  route({ method: 'GET', url: '/matters', meta: { can: 'matter:read' }, handler: () => ({ internal: true }) }),
  route({
    method: 'GET',
    url: '/portal/matters',
    meta: { can: 'matter:read', audience: 'portal' },
    handler: () => ({ portal: true }),
  }),
  route({
    method: 'GET',
    url: '/pricing',
    meta: { can: 'matter:read', audience: 'public' },
    handler: () => ({ open: true }),
  }),
]

const PORTAL = { portal: { roles: ['client'], allow: ['portal', 'public'] } }

async function boot(audiences: Record<string, { roles: string[]; allow: string[] }>) {
  const store = new MemoryAccessStore()
  await store.grantToRole('client', ['matter:read'], 'global')
  await store.grantToRole('lawyer', ['matter:read'], 'global')
  await store.assignRole('a-client', 'client', 'global')
  await store.assignRole('a-lawyer', 'lawyer', 'global')
  // A lawyer who is also a client of their own firm.
  await store.assignRole('both', 'client', 'global')
  await store.assignRole('both', 'lawyer', 'global')

  const app = await createApp({
    plugins: [fakeAuth, permissionsPlugin({ store, audiences }), fastifyPlugin({ routes })],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

const get = (
  server: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number }> },
  url: string,
  user: string,
) => server.inject({ method: 'GET', url, headers: { 'x-user-id': user } })

describe('F-30 · meta.audience', () => {
  it('refuses a confined role on a route that declares no audience', async () => {
    const { app, server } = await boot(PORTAL)
    // The whole point. `/matters` never mentions audiences, and that is exactly
    // why the client must not reach it: a route nobody thought about is a route
    // nobody secured. The permission alone says yes — `matter:read` is granted
    // to the client role — and the audience is what says no.
    expect((await get(server, '/matters', 'a-client')).statusCode).toBe(403)
    await app.shutdown()
  })

  it('lets the same role through on a route that names its audience', async () => {
    const { app, server } = await boot(PORTAL)
    expect((await get(server, '/portal/matters', 'a-client')).statusCode).toBe(200)
    expect((await get(server, '/pricing', 'a-client')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('leaves an unconfined role alone everywhere', async () => {
    const { app, server } = await boot(PORTAL)
    // A lawyer belongs to no audience, so audiences say nothing about them.
    // Confining everyone by default would mean marking every internal route,
    // and a rule that needs hundreds of markers is a rule that gets one wrong.
    for (const url of ['/matters', '/portal/matters', '/pricing']) {
      expect((await get(server, url, 'a-lawyer')).statusCode).toBe(200)
    }
    await app.shutdown()
  })

  it('does not confine someone who also holds an unconfined role', async () => {
    const { app, server } = await boot(PORTAL)
    // Refusing them would lock a member of staff out of their own workplace the
    // day the firm made them a client. Confine only those who have nothing else
    // — the rule the application that found this leak arrived at.
    expect((await get(server, '/matters', 'both')).statusCode).toBe(200)
    await app.shutdown()
  })

  it('does nothing at all when no audiences are configured', async () => {
    const { app, server } = await boot({})
    for (const user of ['a-client', 'a-lawyer']) {
      expect((await get(server, '/matters', user)).statusCode).toBe(200)
    }
    await app.shutdown()
  })

  it('still refuses when the permission is missing, audience or not', async () => {
    const { app, server } = await boot(PORTAL)
    // Audiences narrow; they never widen. A caller with no roles holds no
    // permission, and naming an audience must not become a way in.
    expect((await get(server, '/portal/matters', 'nobody')).statusCode).toBe(403)
    await app.shutdown()
  })
})

describe('F-30 · two confined roles', () => {
  const TWO = {
    portal: { roles: ['client'], allow: ['portal', 'public'] },
    vendor: { roles: ['supplier'], allow: ['vendor', 'public'] },
  }

  async function bootTwo() {
    const store = new MemoryAccessStore()
    await store.grantToRole('client', ['matter:read'], 'global')
    await store.grantToRole('supplier', ['matter:read'], 'global')
    await store.assignRole('u', 'client', 'global')
    await store.assignRole('u', 'supplier', 'global')

    const app = await createApp({
      plugins: [
        fakeAuth,
        permissionsPlugin({ store, audiences: TWO }),
        fastifyPlugin({
          routes: [
            ...routes,
            route({
              method: 'GET',
              url: '/vendor/orders',
              meta: { can: 'matter:read', audience: 'vendor' },
              handler: () => ({ vendor: true }),
            }),
          ],
        }),
      ],
    }).boot()
    return { app, server: app.container.get(FASTIFY) }
  }

  it('reaches the union of both rules, and still not the unmarked route', async () => {
    const { app, server } = await bootTwo()
    // Each role genuinely grants reach to its own surface, so holding both
    // grants both. What it does not grant is anything neither rule names.
    expect((await get(server, '/portal/matters', 'u')).statusCode).toBe(200)
    expect((await get(server, '/vendor/orders', 'u')).statusCode).toBe(200)
    expect((await get(server, '/pricing', 'u')).statusCode).toBe(200)
    expect((await get(server, '/matters', 'u')).statusCode).toBe(403)
    await app.shutdown()
  })

  it('reports a denial, not a crash, on the unmarked route', async () => {
    const { app, server } = await bootTwo()
    const r = await server.inject({ method: 'GET', url: '/matters', headers: { 'x-user-id': 'u' } })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('PERMISSION_DENIED')
    await app.shutdown()
  })
})
