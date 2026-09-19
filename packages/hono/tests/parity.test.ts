import { createApp, type BasaltApp } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { contentType, multipart } from '../../http/tests/multipart-fixtures.js'
import {
  errorDetailsParitySuite,
  rateLimitKeyParitySuite,
  uploadParitySuite,
  type ParityDriver,
  type ParityRequest,
} from '../../http/tests/adapter-parity.js'
import { HONO, honoPlugin } from '../src/index.js'

let app: BasaltApp | undefined

/** `env` as @hono/node-server passes it: every request comes from the same address. */
const env = { incoming: { socket: { remoteAddress: '203.0.113.20' } } }

function toRequest(request: ParityRequest): Request {
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers: request.headers ?? {} }
  if (Array.isArray(request.body)) {
    const chunks = [...request.body]
    init.body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(new Uint8Array(next))
        else controller.close()
      },
    })
    init.duplex = 'half'
  } else if (request.body) {
    init.body = new Uint8Array(request.body)
    ;(init.headers as Record<string, string>)['content-length'] = String(request.body.length)
  }
  return new Request(`http://local${request.url}`, init)
}

const driver: ParityDriver = {
  async boot(routes, plugins) {
    app = await createApp({ plugins: [honoPlugin({ routes, onError: () => {} }), ...plugins] }).boot()
    const hono = app.container.get(HONO)
    return async (request) => {
      const res = await hono.fetch(toRequest(request), env)
      const raw = await res.text()
      let json: unknown = raw
      try {
        json = raw ? JSON.parse(raw) : undefined
      } catch {
        /* not JSON */
      }
      return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) }
    }
  },
  async close() {
    await app?.shutdown()
    app = undefined
  },
}

uploadParitySuite('hono', driver)
rateLimitKeyParitySuite('hono', driver)
errorDetailsParitySuite('hono', driver)

describe('hono: multipart on routes that are not upload() routes', () => {
  const echo = route({
    method: 'POST',
    url: '/form',
    body: z.object({ a: z.string() }),
    handler: ({ body }) => body,
  })

  it('is still parsed in the handler, and still bounded by bodyLimit', async () => {
    app = await createApp({ plugins: [honoPlugin({ routes: [echo], onError: () => {}, bodyLimit: 1024 })] }).boot()
    const hono = app.container.get(HONO)
    const small = await hono.fetch(toRequest({ method: 'POST', url: '/form', body: multipart([{ name: 'a', value: 'x' }]), headers: { 'content-type': contentType() } }), env)
    expect(small.status).toBe(200)
    expect(await small.json()).toEqual({ a: 'x' })
    const big = await hono.fetch(
      toRequest({ method: 'POST', url: '/form', body: [multipart([{ name: 'a', value: 'x'.repeat(4096) }])], headers: { 'content-type': contentType() } }),
      env,
    )
    expect(big.status).toBe(413)
    await driver.close()
  })
})
