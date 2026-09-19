import type { AddressInfo } from 'node:net'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { route, upload } from '@basaltkit/http'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { contentType, multipart } from '../../http/tests/multipart-fixtures.js'
import {
  fetchSend,
  rateLimitKeyParitySuite,
  uploadParitySuite,
  type ParityDriver,
} from '../../http/tests/adapter-parity.js'
import { FASTIFY, fastifyPlugin } from '../src/index.js'

let app: BasaltApp | undefined

const driver: ParityDriver = {
  async boot(routes, plugins) {
    app = await createApp({ plugins: [fastifyPlugin({ routes, onError: () => {} }), ...plugins] }).boot()
    const instance = app.container.get(FASTIFY)
    await instance.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
    return (request) => fetchSend(base, request)
  },
  async close() {
    await app?.shutdown()
    app = undefined
  },
}

uploadParitySuite('fastify', driver)
rateLimitKeyParitySuite('fastify', driver)

describe('fastify: multipart on routes that are not upload() routes', () => {
  it('still answers 415 (the pass-through parser only serves upload() routes)', async () => {
    const send = await driver.boot(
      [
        route({ method: 'POST', url: '/json', body: z.object({ a: z.number() }), handler: ({ body }) => body }),
        route({ method: 'POST', url: '/up', body: upload({ maxBytes: 1024, maxFiles: 1 }), handler: () => 'ok' }),
      ],
      [],
    )
    const body = multipart([{ name: 'a', value: '1' }])
    const res = await send({ method: 'POST', url: '/json', body, headers: { 'content-type': contentType() } })
    expect(res.status).toBe(415)
    expect((await send({ method: 'POST', url: '/json', body: Buffer.from('{"a":1}'), headers: { 'content-type': 'application/json' } })).json).toEqual({ a: 1 })
    await driver.close()
  })
})
