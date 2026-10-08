/**
 * Runs the central-only route suite (BK-043) against Fastify, here in the
 * package that owns the behaviour. Express and Hono run the same suite from
 * their own parity tests.
 */
import type { AddressInfo } from 'node:net'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { describe, expect, it } from 'vitest'
import { httpFetcher, sendWith, type ParityDriver } from '../../http/tests/adapter-parity.js'
import { isTenantRequired } from '../src/index.js'
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
