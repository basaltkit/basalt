/**
 * prismaPlugin's lease against the pipelines it may run under (BK-077):
 * - the cross-adapter suite (an enricher between tenancy and prisma sees
 *   ctx().db; one lease per request, always returned), here against Fastify —
 *   Express and Hono run the same suite from their own parity tests;
 * - a pre-2.8 `@basaltkit/http` pipeline, which ignores what an enricher
 *   returns and sets no `ctx().onDispose`: prisma must not lease what it can
 *   never give back.
 */
import type { AddressInfo } from 'node:net'
import { createApp, ensureMetadata, runWithContext, type BasaltApp, type RequestContext } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { headerResolver, MemoryTenantSource, tenancyPlugin } from '@basaltkit/tenancy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpFetcher, sendWith, type ParityDriver } from '../../http/tests/adapter-parity.js'
import { DB_POOL, prismaPlugin, TenantPoolExhaustedError } from '../src/index.js'
import { prismaLeaseParitySuite } from './lease-parity.js'

let app: BasaltApp | undefined

const driver: ParityDriver = {
  async boot(routes, plugins, options) {
    app = await createApp({
      plugins: [fastifyPlugin({ routes, onError: options?.onError ?? (() => {}) }), ...plugins],
    }).boot()
    const instance = app.container.get(FASTIFY)
    await instance.listen({ port: 0, host: '127.0.0.1' })
    return sendWith(httpFetcher(`http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`))
  },
  async close() {
    app?.container.get(FASTIFY).server.closeAllConnections()
    await app?.shutdown()
    app = undefined
  },
}

prismaLeaseParitySuite('fastify', driver)

type Enricher = (info: { request: unknown; context: RequestContext; container: unknown }) => unknown

/**
 * What `runRoute` did in `@basaltkit/http` 2.7: run the enrichers in a fresh
 * request context and drop whatever they return — no disposer is ever run,
 * and the context carries no `onDispose`.
 */
async function legacyRequest(container: BasaltApp['container'], tenant: string): Promise<unknown> {
  const context: RequestContext = { requestId: tenant, container: container.createScope() }
  const request = { method: 'GET', url: '/', headers: { 'x-tenant-id': tenant }, query: {}, params: {} }
  return runWithContext(context, async () => {
    for (const enrich of ensureMetadata(container).get<Enricher>('http:enrichers')) {
      await enrich({ request, context, container: context.container })
    }
    return context.db
  })
}

describe('prismaPlugin under an @basaltkit/http 2.7 pipeline (disposers ignored)', () => {
  afterEach(async () => {
    await app?.shutdown()
    app = undefined
    vi.useRealTimers()
  })

  const boot = async (order: 'tenancy-first' | 'prisma-first') => {
    const source = new MemoryTenantSource()
    for (const id of ['t1', 't2', 't3', 't4']) source.add({ id, name: id })
    const tenancy = tenancyPlugin({ source, resolvers: [headerResolver()] })
    const prisma = prismaPlugin({ forTenant: (tenantId) => ({ tenantId }), max: 2, acquireTimeoutMs: 50 })
    app = await createApp({ plugins: order === 'tenancy-first' ? [tenancy, prisma] : [prisma, tenancy] }).boot()
    return app.container
  }

  for (const order of ['tenancy-first', 'prisma-first'] as const) {
    it(`falls back to the 30s hand-out: nothing leaks, no 503 once the window passed (${order})`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const container = await boot(order)
      expect(await legacyRequest(container, 't1')).toEqual({ tenantId: 't1' })
      expect(await legacyRequest(container, 't2')).toEqual({ tenantId: 't2' })

      // Within the 30s the old `get()` gave, both slots are still held: a
      // third tenant gets the 503 it always got (the window is unchanged).
      vi.advanceTimersByTime(10_000)
      const early = legacyRequest(container, 't3').catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(100)
      expect(await early).toBeInstanceOf(TenantPoolExhaustedError)

      // After it, the holds have come back on their own — a lease nobody
      // released would make this a 503 forever.
      await vi.advanceTimersByTimeAsync(31_000)
      for (const tenant of ['t3', 't4', 't1', 't2']) {
        expect(await legacyRequest(container, tenant)).toEqual({ tenantId: tenant })
        await vi.advanceTimersByTimeAsync(31_000)
      }
      expect(container.get(DB_POOL).size).toBeLessThanOrEqual(2)
    })
  }
})
