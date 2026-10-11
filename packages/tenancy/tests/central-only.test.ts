/**
 * Runs the central-only route suite (BK-043) against Fastify, here in the
 * package that owns the behaviour. Express and Hono run the same suite from
 * their own parity tests.
 */
import type { AddressInfo } from 'node:net'
import { createApp, ensureMetadata, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { route, runRoute, type HttpReply, type RequestEnricher } from '../../http/src/index.js'
import { describe, expect, it } from 'vitest'
import { httpFetcher, sendWith, type ParityDriver } from '../../http/tests/adapter-parity.js'
import {
  InvalidTenantMetaError,
  MemoryTenantSource,
  headerResolver,
  isTenantRequired,
  tenancyPlugin,
} from '../src/index.js'
import { centralOnlyParitySuite } from './central-only-parity.js'

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

centralOnlyParitySuite('fastify', driver)

describe("isTenantRequired with meta.tenant 'never'", () => {
  it('never requires a tenant, whatever the app-wide default', () => {
    expect(isTenantRequired(true, '/platform', { tenant: 'never' })).toBe(false)
    expect(isTenantRequired({ except: [] }, '/platform', { tenant: 'never' })).toBe(false)
  })
})

describe('an unknown meta.tenant fails closed at request time (a driver that skipped the boot check)', () => {
  it('isTenantRequired throws a 500 instead of falling back to `required`', () => {
    for (const required of [true, false, { except: ['/typo'] }]) {
      expect(() => isTenantRequired(required, '/typo', { tenant: 'none' })).toThrow(InvalidTenantMetaError)
    }
    try {
      isTenantRequired(true, '/typo', { tenant: null })
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ code: 'TENANCY_INVALID_ROUTE_META', status: 500 })
    }
  })

  it('the enricher refuses before resolving — with or without a tenant on the request', async () => {
    const app = await createApp({
      plugins: [
        tenancyPlugin({
          source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }),
          resolvers: [headerResolver()],
          required: false,
        }),
      ],
    }).boot()
    try {
      const [enrich] = ensureMetadata(app.container).get<
        (input: { request: unknown; context: Record<string, unknown>; container: unknown; route?: unknown }) => Promise<void>
      >('http:enrichers')
      const route = { meta: { tenant: 'optional' } }
      for (const headers of [{}, { 'x-tenant-id': 'acme' }]) {
        const context: Record<string, unknown> = {}
        await expect(enrich!({ request: { headers, url: '/typo' }, context, container: app.container, route })).rejects.toBeInstanceOf(
          InvalidTenantMetaError,
        )
        expect(context['tenant']).toBeUndefined()
      }
    } finally {
      await app.shutdown()
    }
  })
})
