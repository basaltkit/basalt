import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp, type BasaltApp } from '@basaltkit/core'
import {
  httpFetcher,
  sendWith,
  errorDetailsParitySuite,
  disposerParitySuite,
  corsPreflightParitySuite,
  wireParitySuite,
  metaValidatorParitySuite,
  routeTableParitySuite,
  enricherReplyParitySuite,
  rateLimitKeyParitySuite,
  rateLimitWarningParitySuite,
  rawBodyParitySuite,
  crossCopyParitySuite,
  streamParitySuite,
  uploadParitySuite,
  type ParityDriver,
} from '../../http/tests/adapter-parity.js'
import { fileRoutesParitySuite } from '../../files/tests/route-parity.js'
import { commentRoutesParitySuite } from '../../comments/tests/route-parity.js'
import { realtimeSseParitySuite } from '../../realtime/tests/sse-parity.js'
import { centralOnlyParitySuite } from '../../tenancy/tests/central-only-parity.js'
import { EXPRESS, expressPlugin } from '../src/index.js'

let app: BasaltApp | undefined
let server: Server | undefined

const driver: ParityDriver = {
  async boot(routes, plugins, options) {
    app = await createApp({
      plugins: [expressPlugin({ routes, onError: options?.onError ?? (() => {}) }), ...plugins],
    }).boot()
    server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return sendWith(httpFetcher(base))
  },
  async close() {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }
    await app?.shutdown()
    server = undefined
    app = undefined
  },
}

uploadParitySuite('express', driver)
rawBodyParitySuite('express', driver)
crossCopyParitySuite('express', driver)
rateLimitKeyParitySuite('express', driver)
rateLimitWarningParitySuite('express', driver)
errorDetailsParitySuite('express', driver)
streamParitySuite('express', driver)
corsPreflightParitySuite('express', driver)
wireParitySuite('express', driver)
metaValidatorParitySuite('express', driver)
routeTableParitySuite('express', driver)
enricherReplyParitySuite('express', driver)
fileRoutesParitySuite('express', driver)
commentRoutesParitySuite('express', driver)
realtimeSseParitySuite('express', driver)
disposerParitySuite('express', driver)
centralOnlyParitySuite('express', driver)
