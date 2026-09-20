/**
 * Runs the `fileRoutes()` streaming suite against Fastify, here in the package
 * that owns the routes. The Express and Hono adapters run the very same suite
 * from their own parity tests (they cannot be imported here: neither is a
 * dependency of @basaltkit/files), which is what keeps the three in step.
 */
import type { AddressInfo } from 'node:net'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { httpFetcher, sendWith, type ParityDriver } from '../../http/tests/adapter-parity.js'
import { fileRoutesParitySuite } from './route-parity.js'

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
    // A request whose body the server never read (e.g. a 404 answered early)
    // leaves a socket the graceful close would wait on forever.
    app?.container.get(FASTIFY).server.closeAllConnections()
    await app?.shutdown()
    app = undefined
  },
}

fileRoutesParitySuite('fastify', driver)
