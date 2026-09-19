import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp, type BasaltApp } from '@basaltkit/core'
import {
  fetchSend,
  rateLimitKeyParitySuite,
  uploadParitySuite,
  type ParityDriver,
} from '../../http/tests/adapter-parity.js'
import { EXPRESS, expressPlugin } from '../src/index.js'

let app: BasaltApp | undefined
let server: Server | undefined

const driver: ParityDriver = {
  async boot(routes, plugins) {
    app = await createApp({ plugins: [expressPlugin({ routes, onError: () => {} }), ...plugins] }).boot()
    server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return (request) => fetchSend(base, request)
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
rateLimitKeyParitySuite('express', driver)
