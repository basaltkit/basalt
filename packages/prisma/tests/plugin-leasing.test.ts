import { afterEach, describe, expect, it } from 'vitest'
import { createApp, ctx, type BasaltApp, type BasaltPlugin } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route } from '@basaltkit/fastify'
import { headerResolver, MemoryTenantSource, TENANCY, tenancyPlugin } from '@basaltkit/tenancy'
import { DB_POOL, prismaPlugin, TenantClientPool, TenantPoolExhaustedError } from '../src/index.js'

// BK-077: prismaPlugin handed clients out with `pool.get()` — "in use" for
// `idleMs` (30s) after the call, never leased. The (max+1)th distinct tenant
// within 30s waited `acquireTimeoutMs` and got a 503, while nothing was in use.

interface LeaseCounts {
  acquired: number
  released: number
  gets: number
}

/** Counts the pool's hand-outs, so a test can assert every lease came back. */
function instrument(pool: TenantClientPool<unknown>): LeaseCounts {
  const counts: LeaseCounts = { acquired: 0, released: 0, gets: 0 }
  const acquire = pool.acquire.bind(pool)
  const get = pool.get.bind(pool)
  pool.acquire = async (tenantId: string) => {
    const lease = await acquire(tenantId)
    counts.acquired++
    let done = false
    return {
      client: lease.client,
      release: () => {
        if (!done) counts.released++
        done = true
        lease.release()
      },
    }
  }
  pool.get = async (tenantId: string) => {
    counts.gets++
    return get(tenantId)
  }
  return counts
}

const TENANTS = ['t1', 't2', 't3', 't4', 't5', 't6']

const source = () => {
  const tenants = new MemoryTenantSource()
  for (const id of TENANTS) tenants.add({ id, name: id })
  return tenants
}

const routes = [
  route({
    method: 'GET',
    url: '/who',
    handler: () => ({ tenant: ctx().tenant?.id ?? null, db: (ctx().db as { tenantId?: string })?.tenantId ?? null }),
  }),
  route({
    method: 'GET',
    url: '/boom',
    handler: () => {
      throw new Error('handler failed')
    },
  }),
]

let app: BasaltApp | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

// `idleMs: 0` keeps the tests independent of the (1s) grace window, which is
// covered on its own below.
const prisma = () =>
  prismaPlugin({
    forTenant: (tenantId) => ({ tenantId }),
    max: 2,
    idleMs: 0,
    acquireTimeoutMs: 200,
  })

async function boot(order: 'tenancy-first' | 'prisma-first') {
  const tenancy = tenancyPlugin({ source: source(), resolvers: [headerResolver()] })
  const plugins: BasaltPlugin[] =
    order === 'tenancy-first' ? [tenancy, prisma()] : [prisma(), tenancy]
  app = await createApp({ plugins: [...plugins, fastifyPlugin({ routes })] }).boot()
  const counts = instrument(app.container.get(DB_POOL))
  const server = app.container.get(FASTIFY)
  const get = (url: string, tenant: string) =>
    server.inject({ method: 'GET', url, headers: { 'x-tenant-id': tenant } })
  return { counts, get }
}

describe('prismaPlugin leases the tenant client per request (BK-077)', () => {
  for (const order of ['tenancy-first', 'prisma-first'] as const) {
    it(`serves more distinct tenants than \`max\` back to back, no 503 (${order})`, async () => {
      const { counts, get } = await boot(order)
      for (const tenant of TENANTS) {
        const res = await get('/who', tenant)
        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ tenant, db: tenant })
      }
      // One lease per request — the tenancy enricher's 'tenancy:switched' must
      // not take a second one that nobody releases — and every one returned.
      expect(counts.acquired).toBe(TENANTS.length)
      expect(counts.released).toBe(TENANTS.length)
      expect(counts.gets).toBe(0)
      expect(app!.container.get(DB_POOL).size).toBeLessThanOrEqual(2)
    })
  }

  it('with the default grace window a new tenant waits ~1s for an idle slot, not a 503', async () => {
    app = await createApp({
      plugins: [
        tenancyPlugin({ source: source(), resolvers: [headerResolver()] }),
        prismaPlugin({ forTenant: (tenantId) => ({ tenantId }), max: 2, acquireTimeoutMs: 5_000 }),
        fastifyPlugin({ routes }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    for (const tenant of ['t1', 't2']) {
      expect((await server.inject({ url: '/who', headers: { 'x-tenant-id': tenant } })).statusCode).toBe(200)
    }
    const started = Date.now()
    const res = await server.inject({ url: '/who', headers: { 'x-tenant-id': 't3' } })
    expect(res.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(2_500)
  })

  it('releases the lease when the handler throws', async () => {
    const { counts, get } = await boot('tenancy-first')
    const res = await get('/boom', 't1')
    expect(res.statusCode).toBe(500)
    expect(counts.acquired).toBe(1)
    expect(counts.released).toBe(1)
  })

  it('still answers 503 when more tenants than `max` are genuinely in use at once', async () => {
    app = await createApp({ plugins: [prisma()] }).boot()
    const pool = app.container.get(DB_POOL)
    const a = await pool.acquire('t1')
    const b = await pool.acquire('t2')
    const error = await pool.get('t3').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TenantPoolExhaustedError)
    expect((error as TenantPoolExhaustedError).details).toMatchObject({ max: 2, leased: 2, recentlyUsed: 0 })
    expect((error as Error).message).toContain('Raise `max`')
    a.release()
    b.release()
  })
})

describe('prismaPlugin leases the tenant client per tenancy.run (BK-077)', () => {
  it('leases on entry, releases on exit, and restores the outer client when nested', async () => {
    app = await createApp({
      plugins: [tenancyPlugin({ source: source(), resolvers: [headerResolver()] }), prisma()],
    }).boot()
    const counts = instrument(app.container.get(DB_POOL))
    const tenancy = app.container.get(TENANCY)
    const seen: string[] = []
    await tenancy.run('t1', async () => {
      seen.push((ctx().db as { tenantId: string }).tenantId)
      await tenancy.run('t2', async () => {
        seen.push((ctx().db as { tenantId: string }).tenantId)
      })
      // the inner lease is already back; the outer one is still held
      expect(counts.released).toBe(1)
      seen.push((ctx().db as { tenantId: string }).tenantId)
    })
    expect(seen).toEqual(['t1', 't2', 't1'])
    expect(counts.acquired).toBe(2)
    expect(counts.released).toBe(2)
    expect(counts.gets).toBe(0)
  })

  it('releases when the callback throws', async () => {
    app = await createApp({
      plugins: [tenancyPlugin({ source: source(), resolvers: [headerResolver()] }), prisma()],
    }).boot()
    const counts = instrument(app.container.get(DB_POOL))
    const tenancy = app.container.get(TENANCY)
    await expect(
      tenancy.run('t1', () => {
        throw new Error('job failed')
      }),
    ).rejects.toThrow('job failed')
    expect(counts.acquired).toBe(1)
    expect(counts.released).toBe(1)
  })

  it('cycles through more tenants than `max` in tenancy.forEach', async () => {
    app = await createApp({
      plugins: [tenancyPlugin({ source: source(), resolvers: [headerResolver()] }), prisma()],
    }).boot()
    const counts = instrument(app.container.get(DB_POOL))
    const visited: string[] = []
    await app.container.get(TENANCY).forEach(
      () => void visited.push((ctx().db as { tenantId: string }).tenantId),
      { concurrency: 2 },
    )
    expect(visited.sort()).toEqual(TENANTS)
    expect(counts.released).toBe(counts.acquired)
  })

  it('falls back to the time-based get() for a switch that never says when it ends', async () => {
    app = await createApp({ plugins: [prisma()] }).boot()
    const counts = instrument(app.container.get(DB_POOL))
    const { runWithContext } = await import('@basaltkit/core')
    await runWithContext({ tenant: { id: 't1' } }, async () => {
      await app!.hooks.emit('tenancy:switched', { tenant: { id: 't1' } } as never)
      expect((ctx().db as { tenantId: string }).tenantId).toBe('t1')
    })
    expect(counts.acquired).toBe(0)
    expect(counts.gets).toBe(1)
  })
})
