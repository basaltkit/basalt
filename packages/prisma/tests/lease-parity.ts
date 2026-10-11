/**
 * Cross-adapter suite for prismaPlugin's per-request lease (BK-077): an
 * enricher registered BETWEEN tenancyPlugin and prismaPlugin must see
 * `ctx().db`, a request must hold exactly one lease per tenant, and that lease
 * must come back however the request ends — including when a later enricher
 * rejects it. Not a test file on its own: prisma runs it against Fastify, and
 * the Express and Hono adapters run the very same suite from their own parity
 * tests (neither is a dependency of @basaltkit/prisma).
 *
 * Routes are plain `BasaltRoute`-shaped objects so this file needs nothing
 * from @basaltkit/http at runtime.
 */
import { ctx, definePlugin, ensureMetadata, type BasaltPlugin } from '@basaltkit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BasaltRoute } from '../../http/src/index.js'
import type { ParityDriver } from '../../http/tests/adapter-parity.js'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '../../tenancy/src/index.js'
import { DB_POOL, prismaPlugin, type TenantClientPool } from '../src/index.js'

const TENANTS = ['t1', 't2', 't3', 't4']

export function prismaLeaseParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: prismaPlugin per-request lease, any registration order (BK-077)`, () => {
    afterEach(() => driver.close())

    const counts = { acquired: 0, released: 0 }
    const seenByEnricher: (string | null)[] = []

    /** Counts the pool's leases, so a test can assert every one came back. */
    const instrument = definePlugin({
      name: 'test:count-leases',
      boot({ container }) {
        const pool = container.get(DB_POOL) as TenantClientPool<unknown>
        const acquire = pool.acquire.bind(pool)
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
      },
    })

    /** Stands in for auth: reads ctx().db, then may reject the request. */
    const middle = definePlugin({
      name: 'test:reads-db',
      register({ container }) {
        ensureMetadata(container).add(
          'http:enrichers',
          ({ context, request }: { context: { db?: unknown }; request: { headers: Record<string, unknown> } }) => {
            seenByEnricher.push((context.db as { tenantId?: string } | undefined)?.tenantId ?? null)
            if (request.headers['x-reject'] === '1') {
              throw Object.assign(new Error('Sign in.'), { status: 401, expose: true })
            }
          },
        )
      },
    })

    const tenancy = () => {
      const source = new MemoryTenantSource()
      for (const id of TENANTS) source.add({ id, name: id })
      return tenancyPlugin({ source, resolvers: [headerResolver()] })
    }

    // `idleMs: 0` and a short wait: a leaked lease shows up as a quick 503.
    const prisma = () =>
      prismaPlugin({ forTenant: (tenantId) => ({ tenantId }), max: 2, idleMs: 0, acquireTimeoutMs: 300 })

    const routes = [
      {
        method: 'GET',
        url: '/who',
        handler: () => ({ db: (ctx().db as { tenantId?: string } | undefined)?.tenantId ?? null }),
      },
    ] as BasaltRoute[]

    const reset = () => {
      counts.acquired = 0
      counts.released = 0
      seenByEnricher.length = 0
    }

    /** Disposers run when the response has ended, which may trail the client a tick. */
    const allReleased = () => vi.waitFor(() => expect(counts.released).toBe(counts.acquired), { timeout: 1_000 })

    const orders: Record<string, () => BasaltPlugin[]> = {
      'tenancy → enricher → prisma': () => [tenancy(), middle, prisma(), instrument],
      'prisma → tenancy → enricher': () => [prisma(), tenancy(), middle, instrument],
      'tenancy → prisma → enricher': () => [tenancy(), prisma(), middle, instrument],
    }

    for (const [order, plugins] of Object.entries(orders)) {
      it(`an enricher sees ctx().db and every lease comes back (${order})`, async () => {
        reset()
        const send = await driver.boot(routes, plugins())
        for (const tenant of TENANTS) {
          const res = await send({ method: 'GET', url: '/who', headers: { 'x-tenant-id': tenant } })
          expect(res.status).toBe(200)
          expect(res.json).toEqual({ db: tenant })
          await allReleased()
        }
        expect(seenByEnricher).toEqual(TENANTS)
        // Exactly one lease per request, whichever plugin leased first.
        expect(counts.acquired).toBe(TENANTS.length)
      })
    }

    it('releases the lease when an enricher after tenancy rejects the request (tenancy → enricher → prisma)', async () => {
      reset()
      const send = await driver.boot(routes, orders['tenancy → enricher → prisma']!())
      for (const tenant of TENANTS) {
        const res = await send({
          method: 'GET',
          url: '/who',
          headers: { 'x-tenant-id': tenant, 'x-reject': '1' },
        })
        expect(res.status).toBe(401)
        await allReleased()
      }
      expect(counts.acquired).toBe(TENANTS.length)
    })
  })
}
