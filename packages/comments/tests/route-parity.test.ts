/**
 * Runs the `commentRoutes()` suite against Fastify, here in the package that
 * owns the routes. The Express and Hono adapters run the very same suite from
 * their own parity tests (neither is a dependency of @basaltkit/comments),
 * which is what keeps the three in step.
 */
import type { AddressInfo } from 'node:net'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { httpFetcher, sendWith, type ParityDriver } from '../../http/tests/adapter-parity.js'
import { commentRoutesParitySuite } from './route-parity.js'

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

commentRoutesParitySuite('fastify', driver)
