import { describe, expect, it } from 'vitest'
import { createApp, ctx, tryCtx } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import {
  headerResolver,
  MemoryTenantSource,
  routeResolver,
  subdomainResolver,
  domainResolver,
  Tenancy,
  TENANCY,
  tenancyPlugin,
  TenantNotFoundError,
  isTenantRequired,
} from '../src/index.js'

const source = () =>
  new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc', domains: ['app.acme.com'] })
    .add({ id: 'globex', name: 'Globex' })

describe('resolvers', () => {
  it('subdomainResolver extracts the first label and ignores www/base/nested', () => {
    const resolve = subdomainResolver({ base: 'basalt.app' })
    expect(resolve({ headers: { host: 'acme.basalt.app' } })).toEqual({ id: 'acme' })
    expect(resolve({ headers: { host: 'acme.basalt.app:3000' } })).toEqual({ id: 'acme' })
    expect(resolve({ headers: { host: 'basalt.app' } })).toBeNull()
    expect(resolve({ headers: { host: 'www.basalt.app' } })).toBeNull()
    expect(resolve({ headers: { host: 'a.b.basalt.app' } })).toBeNull()
    expect(resolve({ headers: { host: 'other.com' } })).toBeNull()
  })

  it('headerResolver and routeResolver read their inputs', () => {
    expect(headerResolver()({ headers: { 'x-tenant-id': 'acme' } })).toEqual({ id: 'acme' })
    expect(headerResolver({ header: 'x-org' })({ headers: { 'x-org': 'g' } })).toEqual({ id: 'g' })
    expect(routeResolver()({ params: { tenant: 'acme' } })).toEqual({ id: 'acme' })
    expect(routeResolver()({})).toBeNull()
  })
})

describe('Tenancy', () => {
  it('resolve: first resolver that loads an existing tenant wins', async () => {
    const tenancy = new Tenancy(source(), [
      headerResolver(),
      subdomainResolver({ base: 'basalt.app' }),
    ])
    // header identifies an unknown tenant → falls through to the subdomain
    const tenant = await tenancy.resolve({
      headers: { 'x-tenant-id': 'ghost', host: 'globex.basalt.app' },
    })
    expect(tenant?.id).toBe('globex')
  })

  it('resolves custom domains through source.findByDomain', async () => {
    const tenancy = new Tenancy(source(), [domainResolver()])
    const tenant = await tenancy.resolve({ headers: { host: 'app.acme.com' } })
    expect(tenant?.id).toBe('acme')
  })

  it('run(): sets ctx().tenant, preserves outer context and restores after', async () => {
    const tenancy = new Tenancy(source(), [])
    const seen = await tenancy.run('acme', async () => {
      return { tenant: ctx().tenant?.id, requestId: ctx().requestId }
    })
    expect(seen).toEqual({ tenant: 'acme', requestId: undefined })
    expect(tryCtx()?.tenant).toBeUndefined()

    await expect(tenancy.run('ghost', () => {})).rejects.toBeInstanceOf(TenantNotFoundError)
  })

  it('forEach(): visits every tenant inside its own context, bounded concurrency', async () => {
    const tenancy = new Tenancy(source(), [])
    const visited: string[] = []
    await tenancy.forEach(
      async (tenant) => {
        expect(ctx().tenant?.id).toBe(tenant.id)
        visited.push(tenant.id)
      },
      { concurrency: 2 },
    )
    expect(visited.sort()).toEqual(['acme', 'globex'])
  })
})

describe('tenancyPlugin + fastify (end to end)', () => {
  const routes = [
    route({
      method: 'GET',
      url: '/whoami',
      async handler() {
        return { tenant: ctx().tenant?.id ?? null }
      },
    }),
    route({
      method: 'GET',
      url: '/health',
      async handler() {
        return { ok: true }
      },
    }),
    route({
      method: 'GET',
      url: '/public/pricing',
      async handler() {
        return { ok: true }
      },
    }),
    // Declarada como central na própria aRoute.
    route({
      method: 'GET',
      url: '/central',
      meta: { tenant: false },
      async handler() {
        return { central: true }
      },
    }),
    // Declarada como de tenant, mesmo when o default da app é permissivo.
    route({
      method: 'GET',
      url: '/tenant-only',
      meta: { tenant: true },
      async handler() {
        return { tenant: ctx().tenant?.id ?? null }
      },
    }),
  ]

  const boot = async (required: boolean | { except: (string | RegExp)[] }) => {
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: source(), resolvers: [headerResolver()], required }),
        fastifyPlugin({ routes }),
      ],
    }).boot()
    return { app, server: app.container.get(FASTIFY) }
  }

  it('resolves the tenant per request and fires tenancy:switched', async () => {
    const { app, server } = await boot(false)
    const switched: string[] = []
    app.hooks.on('tenancy:switched', ({ tenant }) => void switched.push(tenant.id))

    const res = await server.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-tenant-id': 'acme' },
    })
    expect(res.json()).toEqual({ tenant: 'acme' })
    expect(switched).toEqual(['acme'])

    const central = await server.inject({ method: 'GET', url: '/whoami' })
    expect(central.json()).toEqual({ tenant: null })
    await app.shutdown()
  })

  it('required: true rejects unresolved requests with 404 TENANCY_NOT_RESOLVED', async () => {
    const { app, server } = await boot(true)
    const res = await server.inject({ method: 'GET', url: '/whoami' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('TENANCY_NOT_RESOLVED')

    const ok = await server.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-tenant-id': 'globex' },
    })
    expect(ok.json()).toEqual({ tenant: 'globex' })
    await app.shutdown()
  })

  it('required: { except } lets public paths through and still guards the rest', async () => {
    // A health check has no tenant to send, and neither does a load balancer.
    // Without an exemption, `required: true` is unusable for any app that has
    // one — which is every app.
    const { app, server } = await boot({ except: ['/health', /^\/public\//] })

    const health = await server.inject({ method: 'GET', url: '/health' })
    expect(health.statusCode).toBe(200)

    const publicPath = await server.inject({ method: 'GET', url: '/public/pricing' })
    expect(publicPath.statusCode).toBe(200)

    // Anything not exempt is still refused.
    const guarded = await server.inject({ method: 'GET', url: '/whoami' })
    expect(guarded.statusCode).toBe(404)
    expect(guarded.json().error.code).toBe('TENANCY_NOT_RESOLVED')

    await app.shutdown()
  })

  it('matches the exempt path ignoring the query string', async () => {
    const { app, server } = await boot({ except: ['/health'] })
    const res = await server.inject({ method: 'GET', url: '/health?probe=1' })
    expect(res.statusCode).toBe(200)
    await app.shutdown()
  })

  describe('route meta.tenant', () => {
    it('meta: { tenant: false } serves a central route even with required: true', async () => {
      const { app, server } = await boot(true)

      const central = await server.inject({ method: 'GET', url: '/central' })
      expect(central.statusCode).toBe(200)
      expect(central.json()).toEqual({ central: true })

      // Every other route is still guarded.
      const guarded = await server.inject({ method: 'GET', url: '/whoami' })
      expect(guarded.statusCode).toBe(404)

      await app.shutdown()
    })

    it('meta: { tenant: true } guards one route even with required off', async () => {
      const { app, server } = await boot(false)

      const guarded = await server.inject({ method: 'GET', url: '/tenant-only' })
      expect(guarded.statusCode).toBe(404)
      expect(guarded.json().error.code).toBe('TENANCY_NOT_RESOLVED')

      // The app-wide default is still permissive for everything else.
      const permissive = await server.inject({ method: 'GET', url: '/whoami' })
      expect(permissive.statusCode).toBe(200)
      expect(permissive.json()).toEqual({ tenant: null })

      await app.shutdown()
    })

    it('the route still resolves its tenant normally when one is sent', async () => {
      const { app, server } = await boot(false)
      const res = await server.inject({
        method: 'GET',
        url: '/tenant-only',
        headers: { 'x-tenant-id': 'acme' },
      })
      expect(res.json()).toEqual({ tenant: 'acme' })
      await app.shutdown()
    })
  })

  it('TENANCY token exposes the facade', async () => {
    const { app } = await boot(false)
    const tenancy = app.container.get(TENANCY)
    expect((await tenancy.find('acme'))?.name).toBe('Acme Inc')
    await app.shutdown()
  })
})

describe('tenancy:active metadata marker', () => {
  it('registering tenancyPlugin advertises multi-tenancy for other plugins (e.g. cache fail-closed defaults)', async () => {
    const app = await createApp({
      plugins: [tenancyPlugin({ source: source(), resolvers: [headerResolver()] })],
    }).boot()
    const { ensureMetadata } = await import('@basaltkit/core')
    expect(ensureMetadata(app.container).get('tenancy:active')).toEqual([true])
    await app.shutdown()
  })
})

describe('isTenantRequired', () => {
  it('is off unless asked for', () => {
    expect(isTenantRequired(undefined, '/whoami')).toBe(false)
    expect(isTenantRequired(false, '/whoami')).toBe(false)
  })

  it('true applies everywhere', () => {
    expect(isTenantRequired(true, '/health')).toBe(true)
    expect(isTenantRequired(true, undefined)).toBe(true)
  })

  it('exempts an exact path', () => {
    const required = { except: ['/health'] }
    expect(isTenantRequired(required, '/health')).toBe(false)
    expect(isTenantRequired(required, '/healthz')).toBe(true)
    expect(isTenantRequired(required, '/whoami')).toBe(true)
  })

  it('ignores the query string', () => {
    expect(isTenantRequired({ except: ['/health'] }, '/health?probe=1')).toBe(false)
  })

  // Each adapter reports the URL differently, and an exemption that works on
  // two of them is a bug on the third.
  it.each([
    ['fastify / express', '/health?probe=1'],
    ['hono (absolute URL)', 'http://localhost:3000/health?probe=1'],
    ['hono, no query', 'https://app.example.com/health'],
  ])('matches on %s', (_adapter, url) => {
    expect(isTenantRequired({ except: ['/health'] }, url)).toBe(false)
  })

  it('accepts regular expressions', () => {
    const required = { except: [/^\/public\//] }
    expect(isTenantRequired(required, '/public/pricing')).toBe(false)
    expect(isTenantRequired(required, 'http://host/public/pricing')).toBe(false)
    expect(isTenantRequired(required, '/private/pricing')).toBe(true)
  })

  it('fails closed when there is no URL to match', () => {
    expect(isTenantRequired({ except: ['/health'] }, undefined)).toBe(true)
  })
})

describe('isTenantRequired with route meta', () => {
  it('meta wins over the app-wide default, in both directions', () => {
    expect(isTenantRequired(true, '/anything', { tenant: false })).toBe(false)
    expect(isTenantRequired(false, '/anything', { tenant: true })).toBe(true)
    expect(isTenantRequired({ except: ['/x'] }, '/x', { tenant: true })).toBe(true)
  })

  it('falls back to the default when the route says nothing', () => {
    expect(isTenantRequired(true, '/anything', {})).toBe(true)
    expect(isTenantRequired(true, '/anything', undefined)).toBe(true)
    expect(isTenantRequired(false, '/anything', { other: 'meta' })).toBe(false)
  })

  it('ignores a non-boolean meta.tenant rather than guessing', () => {
    // `meta` is free-form, so another plugin could put anything under this key.
    expect(isTenantRequired(true, '/anything', { tenant: 'yes' })).toBe(true)
    expect(isTenantRequired(false, '/anything', { tenant: 'no' })).toBe(false)
  })
})
