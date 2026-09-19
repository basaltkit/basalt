import { afterEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { z } from 'zod'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { HttpError, MemoryRateLimitStore, route, securityPlugin } from '@basaltkit/http'
import { HONO, honoPlugin, registerRoutes, type HonoPluginOptions } from '../src/index.js'

let seenIp: string | undefined
let seenPad = -1
const routes = [
  route({
    method: 'GET',
    url: '/whoami',
    async handler({ request }) {
      seenIp = request.ip
      return { ip: request.ip ?? null }
    },
  }),
  route({
    method: 'POST',
    url: '/echo',
    body: z.object({ pad: z.string() }),
    async handler({ body }) {
      seenPad = body.pad.length
      return { length: body.pad.length }
    },
  }),
  route({
    method: 'GET',
    url: '/forbidden',
    async handler() {
      throw new HttpError(403, 'FORBIDDEN', 'No.')
    },
  }),
]

let app: BasaltApp | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
  seenIp = undefined
  seenPad = -1
  vi.restoreAllMocks()
})

async function boot(options: Partial<HonoPluginOptions> = {}, ...plugins: unknown[]) {
  app = await createApp({
    plugins: [honoPlugin({ routes, onError: () => {}, ...options }), ...plugins] as never,
  }).boot()
  return app.container.get(HONO)
}

/** `env` as @hono/node-server passes it: the Node IncomingMessage under `incoming`. */
const nodeEnv = (remoteAddress: string) => ({
  incoming: { socket: { remoteAddress } },
})

/** A body streamed with no Content-Length (what a chunked upload looks like to the app). */
function chunkedBody(bytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  const prefix = new TextEncoder().encode('{"pad":"')
  const suffix = new TextEncoder().encode('"}')
  let stage = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        controller.enqueue(prefix)
        stage = 1
      } else if (sent < bytes) {
        const size = Math.min(chunk, bytes - sent)
        controller.enqueue(new Uint8Array(size).fill(0x61))
        sent += size
      } else if (stage === 1) {
        controller.enqueue(suffix)
        stage = 2
      } else controller.close()
    },
  })
}

const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request('http://local/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit)

describe('client ip resolution (security: per-client rate limiting and login throttling)', () => {
  it('populates request.ip from the Node socket (@hono/node-server env)', async () => {
    const hono = await boot()
    const res = await hono.fetch(new Request('http://local/whoami'), nodeEnv('203.0.113.7'))
    expect(res.status).toBe(200)
    expect(seenIp).toBe('203.0.113.7')
  })

  it('populates request.ip from Bun server.requestIP', async () => {
    const hono = await boot()
    const server = {
      requestIP: () => ({ address: '198.51.100.4', family: 'IPv4', port: 1 }),
    }
    await hono.fetch(new Request('http://local/whoami'), server)
    expect(seenIp).toBe('198.51.100.4')
  })

  it('uses an explicit getClientIp resolver when given (e.g. a trusted edge header)', async () => {
    const hono = await boot({
      getClientIp: (c) => c.req.header('cf-connecting-ip'),
    })
    await hono.fetch(
      new Request('http://local/whoami', {
        headers: { 'cf-connecting-ip': '192.0.2.9' },
      }),
    )
    expect(seenIp).toBe('192.0.2.9')
  })

  it('does not trust X-Forwarded-For by default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hono = await boot()
    await hono.fetch(
      new Request('http://local/whoami', {
        headers: { 'x-forwarded-for': '10.9.9.9' },
      }),
    )
    expect(seenIp).toBeUndefined()
  })

  it('rate limits each client separately: one client cannot 429 everyone', async () => {
    const store = new MemoryRateLimitStore()
    const hono = await boot(
      {},
      securityPlugin({
        rateLimit: { limit: 2, windowMs: 60_000, store },
        headers: false,
      }),
    )
    const from = (ip: string) => hono.fetch(new Request('http://local/whoami'), nodeEnv(ip))
    expect((await from('203.0.113.1')).status).toBe(200)
    expect((await from('203.0.113.1')).status).toBe(200)
    expect((await from('203.0.113.1')).status).toBe(429)
    expect((await from('203.0.113.2')).status).toBe(200)
  })

  it('warns once when no client ip can be resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hono = await boot()
    await hono.fetch(new Request('http://local/whoami'))
    await hono.fetch(new Request('http://local/whoami'))
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes('client IP'))
    expect(calls).toHaveLength(1)
  })
})

describe('body limit enforced on the bytes read (security: no unbounded buffering)', () => {
  it('rejects a chunked body without Content-Length that exceeds the limit with 413', async () => {
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(streamed(chunkedBody(5 * 1024 * 1024)))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the 1024-byte limit.',
      },
    })
    expect(seenPad).toBe(-1)
  })

  it('rejects an oversized body even with a Transfer-Encoding header next to a small Content-Length', async () => {
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(
      streamed(chunkedBody(64 * 1024), {
        'transfer-encoding': 'chunked',
        'content-length': '10',
      }),
    )
    expect(res.status).toBe(413)
    expect(seenPad).toBe(-1)
  })

  it('counts the body when the Content-Length header is malformed', async () => {
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(streamed(chunkedBody(64 * 1024), { 'content-length': 'abc' }))
    expect(res.status).toBe(413)
    expect(seenPad).toBe(-1)
  })

  it('bounds form-encoded bodies too', async () => {
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(
      streamed(chunkedBody(64 * 1024), {
        'content-type': 'application/x-www-form-urlencoded',
      }),
    )
    expect(res.status).toBe(413)
  })

  it('still accepts a chunked body within the limit', async () => {
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(streamed(chunkedBody(100)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ length: 100 })
  })

  it('keeps the Content-Length fast path (413 with the standard error envelope)', async () => {
    const hono = await boot({ bodyLimit: 16 })
    const res = await hono.fetch(
      new Request('http://local/echo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2048',
        },
        body: JSON.stringify({ pad: 'x' }),
      }),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})

describe('error responses keep security and CORS headers (security: header parity)', () => {
  it('a route error keeps headers set by the security pre-hook', async () => {
    const hono = await boot(
      {},
      securityPlugin({
        headers: true,
        cors: { origin: 'https://app.example' },
        rateLimit: false,
      }),
    )
    const res = await hono.fetch(
      new Request('http://local/forbidden', {
        headers: { origin: 'https://app.example' },
      }),
    )
    expect(res.status).toBe(403)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toBeTruthy()
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'No.' },
    })
  })

  it('a 413 carries the security headers too', async () => {
    const hono = await boot({ bodyLimit: 16 }, securityPlugin({ headers: true, rateLimit: false }))
    const res = await hono.fetch(
      new Request('http://local/echo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '2048',
        },
        body: JSON.stringify({ pad: 'x' }),
      }),
    )
    expect(res.status).toBe(413)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('body limit cannot be bypassed around the plugin middleware (security: red-team regressions)', () => {
  it('bounds the body of routes mounted with registerRoutes() alone (no plugin middleware)', async () => {
    const hono = new Hono()
    registerRoutes(hono, routes)
    const res = await hono.fetch(streamed(chunkedBody(2 * 1024 * 1024)))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(seenPad).toBe(-1)
  })

  it('registerRoutes() honors an explicit bodyLimit and still serves bodies within it', async () => {
    const hono = new Hono()
    registerRoutes(hono, routes, undefined, [], [], () => {}, undefined, 64)
    expect((await hono.fetch(streamed(chunkedBody(1024)))).status).toBe(413)
    const ok = await hono.fetch(streamed(chunkedBody(16)))
    expect(ok.status).toBe(200)
    expect(seenPad).toBe(16)
  })

  it('does not trust a small Content-Length to bound the bytes actually sent', async () => {
    // A runtime that does not frame the body on Content-Length (a proxy
    // adapter, a hand-built Request) must not let the declared length stand
    // in for counting the bytes.
    const hono = await boot({ bodyLimit: 1024 })
    const res = await hono.fetch(streamed(chunkedBody(5 * 1024 * 1024), { 'content-length': '10' }))
    expect(res.status).toBe(413)
    expect(seenPad).toBe(-1)
  })
})

describe('error reporting cannot alter the response (security: red-team regression)', () => {
  it('a throwing onError reporter still yields the enveloped error with its security headers', async () => {
    const hono = await boot(
      {
        onError: () => {
          throw new Error('reporter down')
        },
      },
      securityPlugin({ rateLimit: false }),
    )
    const res = await hono.fetch(new Request('http://local/forbidden'))
    expect(res.status).toBe(403)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })
})
