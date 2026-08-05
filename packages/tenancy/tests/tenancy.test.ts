import { describe, expect, it } from 'vitest'
import { createApp, ctx, tryCtx } from '@machize/core'
import { FASTIFY, fastifyPlugin, route } from '@machize/fastify'
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
} from '../src/index.js'

const source = () =>
  new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc', domains: ['app.acme.com'] })
    .add({ id: 'globex', name: 'Globex' })

describe('resolvers', () => {
  it('subdomainResolver extracts the first label and ignores www/base/nested', () => {
    const resolve = subdomainResolver({ base: 'machize.app' })
    expect(resolve({ headers: { host: 'acme.machize.app' } })).toEqual({ id: 'acme' })
    expect(resolve({ headers: { host: 'acme.machize.app:3000' } })).toEqual({ id: 'acme' })
    expect(resolve({ headers: { host: 'machize.app' } })).toBeNull()
    expect(resolve({ headers: { host: 'www.machize.app' } })).toBeNull()
    expect(resolve({ headers: { host: 'a.b.machize.app' } })).toBeNull()
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
      subdomainResolver({ base: 'machize.app' }),
    ])
    // header identifies an unknown tenant → falls through to the subdomain
    const tenant = await tenancy.resolve({
      headers: { 'x-tenant-id': 'ghost', host: 'globex.machize.app' },
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
  ]

  const boot = async (required: boolean) => {
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

  it('TENANCY token exposes the facade', async () => {
    const { app } = await boot(false)
    const tenancy = app.container.get(TENANCY)
    expect((await tenancy.find('acme'))?.name).toBe('Acme Inc')
    await app.shutdown()
  })
})
