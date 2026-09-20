import type { AddressInfo } from 'node:net'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { rawBody, route, upload } from '@basaltkit/http'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { contentType, multipart } from '../../http/tests/multipart-fixtures.js'
import {
  httpFetcher,
  sendWith,
  errorDetailsParitySuite,
  rateLimitKeyParitySuite,
  rawBodyParitySuite,
  streamParitySuite,
  uploadParitySuite,
  type ParityDriver,
} from '../../http/tests/adapter-parity.js'
import Fastify from 'fastify'
import { FASTIFY, fastifyPlugin, registerRoutes } from '../src/index.js'

let app: BasaltApp | undefined

const driver: ParityDriver = {
  async boot(routes, plugins, options) {
    app = await createApp({
      plugins: [fastifyPlugin({ routes, onError: options?.onError ?? (() => {}) }), ...plugins],
    }).boot()
    const instance = app.container.get(FASTIFY)
    await instance.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
    return sendWith(httpFetcher(base))
  },
  async close() {
    // A request whose body the server never read (e.g. a 404 answered early)
    // leaves a socket the graceful close would wait on forever.
    app?.container.get(FASTIFY).server.closeAllConnections()
    await app?.shutdown()
    app = undefined
  },
}

uploadParitySuite('fastify', driver)
rawBodyParitySuite('fastify', driver)
rateLimitKeyParitySuite('fastify', driver)
errorDetailsParitySuite('fastify', driver)
streamParitySuite('fastify', driver)

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

describe('fastify: a rawBody() route never touches the app\'s own content-type parsers', () => {
  it('keeps a hand-registered parser in force for every other route', async () => {
    const instance = Fastify()
    // An app that replaced the JSON parser itself — exactly the case the
    // encapsulated scope must not fight over.
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => done(null, { theirs: String(body) }),
    )
    registerRoutes(instance, [
      route({
        method: 'POST',
        url: '/hook',
        body: rawBody({ maxBytes: 1024 }),
        handler: ({ body }) => ({ hex: body.bytes.toString('hex') }),
      }),
      route({ method: 'POST', url: '/json', handler: ({ request }) => request.body }),
    ])
    await instance.listen({ port: 0, host: '127.0.0.1' })
    const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
    try {
      const payload = '{  "b" : 2, "a":1 }'
      const raw = await fetch(`${base}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
      expect(await raw.json()).toEqual({ hex: Buffer.from(payload, 'utf8').toString('hex') })
      // The app's own parser still owns every other route.
      const theirs = await fetch(`${base}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
      expect(await theirs.json()).toEqual({ theirs: payload })
    } finally {
      instance.server.closeAllConnections()
      await instance.close()
    }
  })
})
