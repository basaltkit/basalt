import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { FakeBillingGateway, billingRoutes, definePlans, subscriptionsPlugin } from '@basaltkit/subscriptions'
import { TEAMS, teamsPlugin, tenantMembershipPlugin } from '../src/index.js'

/**
 * End-to-end closure proof for the S-1 residual: `meta.auth` proves *a* logged-in
 * user, but nothing bound that user to the client-resolved tenant — a valid user
 * of tenant A could reach tenant B's billing surface by forging `x-tenant-id`.
 * This mounts the REAL `billingRoutes()` on a real adapter and shows the guard
 * closing exactly that path.
 */

const plans = definePlans({
  free: { price: 0, features: { projects: true } },
  pro: { price: 29, features: { projects: true, api: true } },
})

const secret = 'test-secret-value-123456'

async function boot(withGuard: boolean) {
  const app = await createApp({
    plugins: [
      tenancyPlugin({
        source: new MemoryTenantSource().add({ id: 'acme' }).add({ id: 'globex' }),
        resolvers: [headerResolver()],
      }),
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      teamsPlugin(),
      ...(withGuard ? [tenantMembershipPlugin()] : []),
      subscriptionsPlugin({ plans, gateway: new FakeBillingGateway(), fallbackPlan: 'free' }),
      fastifyPlugin({
        routes: [
          ...authRoutes(),
          ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/no' }),
        ],
      }),
    ],
  }).boot()
  const server = app.container.get(FASTIFY)

  // userA is a member of acme — and of acme ONLY.
  await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@acme.test', password: 'password123' } })
  const token = (
    await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@acme.test', password: 'password123' } })
  ).json().accessToken as string
  const login = await server.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } })
  const userId = (login.json() as { id: string }).id
  await app.container.get(TEAMS).addMember('acme', userId, 'member')

  return { app, server, token }
}

describe('user↔tenant binding on real billing routes (S-1 closure)', () => {
  it('CONTROL — without the guard, a valid acme user reaches tenant globex billing (the gap)', async () => {
    const { app, server, token } = await boot(false)
    const res = await server.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'globex' },
      payload: { returnUrl: 'https://app/back' },
    })
    expect(res.statusCode).toBeLessThan(400) // auth passed; nothing bound user→tenant
    await app.shutdown()
  })

  it('with tenantMembershipPlugin, the same forged x-tenant-id request is a 403', async () => {
    const { app, server, token } = await boot(true)
    const res = await server.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'globex' },
      payload: { returnUrl: 'https://app/back' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: { code: 'TEAM_NOT_A_MEMBER' } })
    await app.shutdown()
  })

  it('the genuine member still manages their own tenant billing', async () => {
    const { app, server, token } = await boot(true)
    const res = await server.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'acme' },
      payload: { returnUrl: 'https://app/back' },
    })
    expect(res.statusCode).toBeLessThan(400)
    await app.shutdown()
  })

  it('unauthenticated billing access stays a 401 (S-1 default) even with the guard on', async () => {
    const { app, server } = await boot(true)
    const res = await server.inject({
      method: 'POST',
      url: '/billing/portal',
      headers: { 'x-tenant-id': 'acme' },
      payload: { returnUrl: 'https://app/back' },
    })
    expect(res.statusCode).toBe(401)
    await app.shutdown()
  })
})
