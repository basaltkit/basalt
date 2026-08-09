import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { FakeBillingGateway, SUBSCRIPTIONS, billingRoutes, definePlans, subscriptionsPlugin } from '@basaltkit/subscriptions'
import { billingPageHtml, billingUiRoutes } from '../src/index.js'

const plans = definePlans({
  free: { price: 0, features: { projects: true } },
  pro: { price: 29, trial: '14d', features: { projects: true, api: true } },
})

describe('billingPageHtml', () => {
  it('renders a self-contained billing page wired to the routes', () => {
    const html = billingPageHtml({ title: 'Subscription', headers: { 'x-tenant-id': 'acme' } })
    expect(html).toContain('<title>Subscription</title>')
    expect(html).toContain("fetch(API + '/billing/info'")
    expect(html).toContain("redirect('/billing/checkout'")
    expect(html).toContain("redirect('/billing/portal')")
    expect(html).toContain('"x-tenant-id":"acme"')
  })
})

const secret = 'test-secret-value-123456'

describe('billingUiRoutes', () => {
  it('serves the page and the info endpoint, and drives checkout/portal', async () => {
    const gateway = new FakeBillingGateway()
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
        authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
        subscriptionsPlugin({ plans, gateway, fallbackPlan: 'free' }),
        fastifyPlugin({
          routes: [
            ...authRoutes(),
            ...billingRoutes({ successUrl: 'https://app/ok', cancelUrl: 'https://app/no' }),
            ...billingUiRoutes({ plans }),
          ],
        }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.test', password: 'password123' } })
    const token = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.test', password: 'password123' } })).json().accessToken
    const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': 'acme' }

    // page
    const page = await server.inject({ method: 'GET', url: '/billing/ui', headers: auth })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')

    // info: no subscription yet, but plans listed
    const info0 = await server.inject({ method: 'GET', url: '/billing/info', headers: auth })
    expect(info0.json().subscription).toBeNull()
    expect((info0.json().plans as unknown[]).map((p) => (p as { name: string }).name)).toEqual(['free', 'pro'])

    // seed a subscription → info reflects it
    await app.container.get(SUBSCRIPTIONS).subscribe('acme', 'pro')
    expect((await server.inject({ method: 'GET', url: '/billing/info', headers: auth })).json().subscription.plan).toBe('pro')

    // checkout + portal (fake gateway → URLs)
    const checkout = await server.inject({ method: 'POST', url: '/billing/checkout', headers: auth, payload: { plan: 'pro' } })
    expect(checkout.json().url).toContain('fake.test/checkout/')
    expect((await server.inject({ method: 'POST', url: '/billing/portal', headers: auth, payload: {} })).json().url).toContain('fake.test/portal/')

    // page requires auth
    expect((await server.inject({ method: 'GET', url: '/billing/ui' })).statusCode).toBe(401)

    await app.shutdown()
  })
})
