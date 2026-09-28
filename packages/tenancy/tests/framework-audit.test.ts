/**
 * Regression tests for the framework audit findings FA-007..FA-011. Each block
 * ports the audit's reproduction with the expectation inverted: the defective
 * behaviour it demonstrated must no longer happen.
 */
import { describe, expect, it } from 'vitest'
import { createApp, ctx } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import {
  CustomDomains,
  DomainReservedError,
  DomainTakenError,
  InvalidDomainError,
  InvalidTenantIdError,
  MemoryDomainStore,
  MemoryTenantSource,
  Tenancy,
  TenantResolutionConflictError,
  authoritative,
  domainResolver,
  headerResolver,
  isTenantRequired,
  normalizeDomain,
  requireTenantId,
  routeResolver,
  subdomainResolver,
  tenancyPlugin,
  tryNormalizeDomain,
  type TenantSource,
} from '../src/index.js'

const source = () => new MemoryTenantSource().add({ id: 'acme' }).add({ id: 'globex' })

describe('FA-007 — authoritative resolvers: no fall-through to a client header', () => {
  it('an unknown subdomain resolves to NO tenant, even with x-tenant-id', async () => {
    const t = new Tenancy(source(), [subdomainResolver({ base: 'app.com' }), headerResolver()])
    expect(await t.resolve({ headers: { host: 'nosuch.app.com', 'x-tenant-id': 'globex' } })).toBeNull()
  })

  it('the header can never override a real subdomain, whatever the list order', async () => {
    const t = new Tenancy(source(), [headerResolver(), subdomainResolver({ base: 'app.com' })])
    expect((await t.resolve({ headers: { host: 'acme.app.com', 'x-tenant-id': 'globex' } }))?.id).toBe('acme')
  })

  it('an unknown custom domain stops resolution too (apex included when domainResolver is listed)', async () => {
    const t = new Tenancy(source(), [
      subdomainResolver({ base: 'app.com' }),
      domainResolver(),
      headerResolver(),
    ])
    expect(await t.resolve({ headers: { host: 'app.com', 'x-tenant-id': 'globex' } })).toBeNull()
    expect(await t.resolve({ headers: { host: 'evil.example', 'x-tenant-id': 'globex' } })).toBeNull()
  })

  it('among authoritative resolvers the first that loads wins (domain before subdomain still works)', async () => {
    const t = new Tenancy(source(), [domainResolver(), subdomainResolver({ base: 'app.com' })])
    expect((await t.resolve({ headers: { host: 'acme.app.com' } }))?.id).toBe('acme')
  })

  it('the header is still the answer when no authoritative resolver names a tenant', async () => {
    const t = new Tenancy(source(), [subdomainResolver({ base: 'app.com' }), headerResolver()])
    expect((await t.resolve({ headers: { host: 'app.com', 'x-tenant-id': 'globex' } }))?.id).toBe('globex')
    expect((await t.resolve({ headers: { host: 'localhost:3000', 'x-tenant-id': 'globex' } }))?.id).toBe('globex')
  })

  it('route params are authoritative; custom resolvers opt in with authoritative()', async () => {
    expect(routeResolver().authoritative).toBe(true)
    expect(headerResolver().authoritative).not.toBe(true)
    const claim = authoritative((req) => ({ id: String(req.headers?.['x-signed-claim']) }))
    const t = new Tenancy(source(), [headerResolver(), claim])
    expect(
      await t.resolve({ headers: { 'x-signed-claim': 'ghost', 'x-tenant-id': 'globex' } }),
    ).toBeNull()
  })

  it("onConflict: 'error' rejects resolvers that load different tenants", async () => {
    const t = new Tenancy(
      source(),
      [subdomainResolver({ base: 'app.com' }), headerResolver()],
      undefined, undefined, 'inline', undefined, undefined, undefined,
      { onConflict: 'error' },
    )
    await expect(
      t.resolve({ headers: { host: 'acme.app.com', 'x-tenant-id': 'globex' } }),
    ).rejects.toBeInstanceOf(TenantResolutionConflictError)
    // agreement, or a single answer, is fine
    expect((await t.resolve({ headers: { host: 'acme.app.com', 'x-tenant-id': 'acme' } }))?.id).toBe('acme')
    expect((await t.resolve({ headers: { host: 'app.com', 'x-tenant-id': 'globex' } }))?.id).toBe('globex')
    expect(await t.resolve({ headers: { host: 'nosuch.app.com', 'x-tenant-id': 'globex' } })).toBeNull()
  })

  it('over HTTP: unknown subdomain + header → 404 when required; conflict → 400 with onConflict', async () => {
    const boot = async (onConflict?: 'error') => {
      const app = await createApp({
        plugins: [
          tenancyPlugin({
            source: source(),
            resolvers: [subdomainResolver({ base: 'app.com' }), headerResolver()],
            required: true,
            ...(onConflict ? { onConflict } : {}),
          }),
          fastifyPlugin({
            routes: [
              route({ method: 'GET', url: '/whoami', handler: async () => ({ tenant: ctx().tenant?.id ?? null }) }),
            ],
          }),
        ],
      }).boot()
      return { app, server: app.container.get(FASTIFY) }
    }
    const a = await boot()
    const unknown = await a.server.inject({
      method: 'GET', url: '/whoami', headers: { host: 'nosuch.app.com', 'x-tenant-id': 'globex' },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.code).toBe('TENANCY_NOT_RESOLVED')
    await a.app.shutdown()

    const b = await boot('error')
    const conflict = await b.server.inject({
      method: 'GET', url: '/whoami', headers: { host: 'acme.app.com', 'x-tenant-id': 'globex' },
    })
    expect(conflict.statusCode).toBe(400)
    expect(conflict.json().error.code).toBe('TENANCY_CONFLICT')
    await b.app.shutdown()
  })
})

describe('FA-008 — resolve() and run() apply the tenant-id grammar', () => {
  it('"Evil:x" does not resolve from the header; "../x" and a 10 KB id never reach source.find', async () => {
    const seen: string[] = []
    const src = new MemoryTenantSource({ validateTenantId: () => true }).add({ id: 'Evil:x' })
    const wrapped: TenantSource = { find: async (id) => { seen.push(id); return src.find(id) } }
    const t = new Tenancy(wrapped, [headerResolver()])
    expect(await t.resolve({ headers: { 'x-tenant-id': 'Evil:x' } })).toBeNull()
    expect(await t.resolve({ headers: { 'x-tenant-id': '../x' } })).toBeNull()
    expect(await t.resolve({ headers: { 'x-tenant-id': 'a'.repeat(10_000) } })).toBeNull()
    expect(seen).toEqual([])
  })

  it('a custom validateTenantId widens resolution consistently', async () => {
    const src = new MemoryTenantSource({ validateTenantId: () => true }).add({ id: 'Legacy' })
    const t = new Tenancy(src, [headerResolver()], undefined, undefined, 'inline', undefined, undefined, (id) => /^[A-Za-z]+$/.test(id))
    expect((await t.resolve({ headers: { 'x-tenant-id': 'Legacy' } }))?.id).toBe('Legacy')
  })

  it('tenancy.run() refuses an object or id outside the grammar', async () => {
    const t = new Tenancy(source(), [])
    await expect(t.run({ id: '../x' }, () => requireTenantId())).rejects.toBeInstanceOf(InvalidTenantIdError)
    await expect(t.run('Evil:x', () => requireTenantId())).rejects.toBeInstanceOf(InvalidTenantIdError)
    expect(await t.run('acme', () => requireTenantId())).toBe('acme')
  })

  it('destroy() refuses an invalid id before marking anything', async () => {
    const t = new Tenancy(source(), [])
    await expect(t.destroy('../x')).rejects.toBeInstanceOf(InvalidTenantIdError)
  })
})

describe('FA-009 — normalizeDomain() validates the hostname grammar instead of URL-parsing', () => {
  it('userinfo, path, percent-encoding, full-width and IP forms are rejected, not rewritten', () => {
    for (const bad of [
      'acme.basalt.app@evil.com',
      'x@acme.basalt.app',
      'acm%65.basalt.app',
      'acme.basalt.app/evil',
      'ａｃｍｅ.basalt.app',
      '0x7f.1',
      '127.0.0.1',
      '[::1]:3000',
      'a b.com',
      'acme.basalt.app:80:80',
      'acme.basalt.app:http',
      '-acme.com',
      'a..com',
      '',
      `${'a'.repeat(64)}.com`,
    ]) {
      expect(tryNormalizeDomain(bad), bad).toBeNull()
      expect(() => normalizeDomain(bad), bad).toThrow(InvalidDomainError)
    }
  })

  it('still canonicalizes case, port, whitespace, trailing dots and accepts punycode', () => {
    expect(normalizeDomain(' App.Acme.COM:8443 ')).toBe('app.acme.com')
    expect(normalizeDomain('app.acme.com.:443')).toBe('app.acme.com')
    expect(normalizeDomain('xn--caf-dma.com')).toBe('xn--caf-dma.com')
    expect(normalizeDomain('localhost')).toBe('localhost')
  })

  it('subdomainResolver does not resolve "x@acme.basalt.app"', async () => {
    const r = subdomainResolver({ base: 'basalt.app' })
    expect(await r({ headers: { host: 'x@acme.basalt.app' } })).toBeNull()
    expect(await r({ headers: { host: 'acme.basalt.app@evil.com' } })).toBeNull()
    expect(await domainResolver()({ headers: { host: 'acme.basalt.app@evil.com' } })).toBeNull()
  })
})

describe('FA-010 — custom-domain squatting', () => {
  const HOUR = 60 * 60 * 1000
  const setup = (opts: { txts?: Record<string, string[][]>; secret?: string; reserved?: string[] } = {}) => {
    let now = 1_000
    let n = 0
    const cd = new CustomDomains({
      store: new MemoryDomainStore(),
      now: () => now,
      token: () => `tok-${++n}`,
      resolveTxt: async (host) => opts.txts?.[host] ?? [],
      ...(opts.secret ? { challengeSecret: opts.secret } : {}),
      ...(opts.reserved ? { reservedDomains: opts.reserved } : {}),
    })
    return { cd, advance: (ms: number) => { now += ms } }
  }

  it('an unverified claim still blocks while fresh, but expires after 72 h by default', async () => {
    const { cd, advance } = setup()
    await cd.add('evil', 'victim.com')
    await expect(cd.add('victim', 'victim.com')).rejects.toBeInstanceOf(DomainTakenError)
    advance(72 * HOUR)
    const { record } = await cd.add('victim', 'victim.com')
    expect(record.tenantId).toBe('victim')
    expect(record.verified).toBe(false)
    expect(await cd.list('evil')).toEqual([])
  })

  it('claimTtlMs is configurable', async () => {
    let now = 0
    const cd = new CustomDomains({ now: () => now, resolveTxt: async () => [], claimTtlMs: 1000 })
    await cd.add('evil', 'victim.com')
    now = 1000
    expect((await cd.add('victim', 'victim.com')).record.tenantId).toBe('victim')
  })

  it('a verified domain never expires', async () => {
    const txts = { '_basalt-verify.victim.com': [['basalt-domain-verify=tok-1']] }
    const { cd, advance } = setup({ txts })
    await cd.add('owner', 'victim.com')
    expect(await cd.verify('owner', 'victim.com')).toBe(true)
    advance(365 * 24 * HOUR)
    await expect(cd.add('other', 'victim.com')).rejects.toBeInstanceOf(DomainTakenError)
  })

  it('the verified TXT wins: the real owner takes over a fresh unverified claim immediately', async () => {
    const txts: Record<string, string[][]> = {}
    const { cd } = setup({ txts, secret: 's3cret' })
    await cd.add('evil', 'victim.com')
    const challenge = cd.challenge('victim', 'victim.com')
    expect(challenge.host).toBe('_basalt-verify.victim.com')
    await expect(cd.add('victim', 'victim.com')).rejects.toBeInstanceOf(DomainTakenError) // not published yet
    txts[challenge.host] = [[challenge.value]]
    const { record } = await cd.add('victim', 'victim.com')
    expect(record).toMatchObject({ tenantId: 'victim', verified: true })
    expect(await cd.tenantOf('victim.com')).toBe('victim')
    // the squatter cannot publish the victim's challenge, so it cannot win it back
    expect(cd.challenge('evil', 'victim.com').value).not.toBe(challenge.value)
    await expect(cd.add('evil', 'victim.com')).rejects.toBeInstanceOf(DomainTakenError)
  })

  it('reservedDomains: the platform apex and its subdomains cannot be claimed', async () => {
    const { cd } = setup({ reserved: ['Basalt.app'] })
    await expect(cd.add('evil', 'basalt.app')).rejects.toBeInstanceOf(DomainReservedError)
    await expect(cd.add('evil', 'acme.basalt.app')).rejects.toBeInstanceOf(DomainReservedError)
    await expect(cd.add('evil', 'x.acme.basalt.app.')).rejects.toBeInstanceOf(DomainReservedError)
    expect((await cd.add('acme', 'notbasalt.app')).record.domain).toBe('notbasalt.app')
  })

  it('add() rejects a value that is not a hostname', async () => {
    const { cd } = setup()
    await expect(cd.add('evil', 'acme.basalt.app@evil.com')).rejects.toBeInstanceOf(InvalidDomainError)
  })
})

describe('FA-011 — required.except with a stateful RegExp is stable', () => {
  it('/g and /y patterns give the same answer on every call', () => {
    for (const pattern of [/^\/public/g, /^\/public/y]) {
      const o = { except: [pattern] }
      const r = [1, 2, 3, 4].map(() => isTenantRequired(o, '/public/x'))
      expect(r).toEqual([false, false, false, false])
    }
  })
})
