import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, definePlugin, type BasaltApp } from '@basaltkit/core'
import { HTTP_SERVER, route, securityPlugin, type HttpErrorReport, type HttpServer } from '@basaltkit/http'
import { EXPRESS, expressPlugin, type ExpressPluginOptions } from '../src/index.js'

// Built at runtime so secret scanners do not flag a fake credential in a test fixture.
const LEAKY_DB_URL = ['postgres://admin', 'hunter2@db:5432/app'].join(':')

const routes = [
  route({
    method: 'POST',
    url: '/echo',
    body: z.object({ n: z.number() }),
    async handler({ body }) {
      return { n: body.n }
    },
  }),
]

/** A pre-hook that fails with a message carrying a secret (e.g. a driver error). */
const failingPreHook = definePlugin({
  name: 'test:failing-pre-hook',
  boot({ container }) {
    ;(container.get(HTTP_SERVER) as HttpServer).use(async ({ request }) => {
      if (request.headers['x-explode']) throw new Error(`connect ECONNREFUSED ${LEAKY_DB_URL}`)
    })
  },
})

let app: BasaltApp | undefined
let server: Server | undefined
const seen: HttpErrorReport[] = []

async function boot(options: Partial<ExpressPluginOptions> = {}, ...plugins: unknown[]) {
  seen.length = 0
  app = await createApp({
    plugins: [expressPlugin({ routes, onError: (r) => void seen.push(r), ...options }), ...plugins] as never,
  }).boot()
  server = app.container.get(EXPRESS).listen(0)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  await app?.shutdown()
  server = undefined
  app = undefined
})

const post = (base: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })

describe('express error middleware (security: no stack traces or internals in error responses)', () => {
  it('maps malformed JSON to a 400 JSON envelope without a stack trace', async () => {
    const base = await boot()
    const res = await post(base, '{"n": ')
    const text = await res.text()
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(JSON.parse(text)).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Malformed request body.' },
    })
    expect(text).not.toMatch(/SyntaxError|node_modules|body-parser|<pre>/)
    expect(seen.map((r) => r.status)).toEqual([400])
  })

  it('maps an oversized body to a 413 JSON envelope', async () => {
    const base = await boot()
    const res = await post(base, JSON.stringify({ n: 1, pad: 'a'.repeat(200_000) }))
    const text = await res.text()
    expect(res.status).toBe(413)
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large.',
      },
    })
    expect(text).not.toMatch(/node_modules|<pre>/)
  })

  it('maps an unsupported body charset to a 415 JSON envelope', async () => {
    const base = await boot()
    const res = await post(base, '{"n":1}', {
      'content-type': 'application/json; charset=klingon',
    })
    expect(res.status).toBe(415)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('maps a corrupt compressed body to a 400 JSON envelope, not a 500', async () => {
    const base = await boot()
    const res = await post(base, 'not-gzip', { 'content-encoding': 'gzip' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
  })

  it('a pre-hook error returns the generic 500 envelope, never its message', async () => {
    const base = await boot({}, failingPreHook)
    const res = await post(base, '{"n":1}', { 'x-explode': '1' })
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    })
    expect(text).not.toContain('hunter2')
    expect(seen.map((r) => r.status)).toEqual([500])
  })

  it('error responses keep the security headers', async () => {
    const base = await boot({}, securityPlugin({ headers: true, rateLimit: false }))
    const res = await post(base, '{"n": ')
    expect(res.status).toBe(400)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('express error middleware cannot be bypassed (security: red-team regressions)', () => {
  const throwingReporter = () => {
    throw new Error(`reporter down ${LEAKY_DB_URL}`)
  }

  it('a throwing onError reporter still yields the JSON envelope, never an HTML stack', async () => {
    const base = await boot({ onError: throwingReporter })
    const res = await post(base, '{"n": ')
    const text = await res.text()
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(text).not.toContain('hunter2')
    expect(text).not.toMatch(/<pre>|\bat /)
  })

  it('a throwing onError reporter on a route error still yields the neutral 500', async () => {
    const base = await boot({
      onError: throwingReporter,
      routes: [
        route({
          method: 'GET',
          url: '/boom',
          async handler() {
            throw new Error('db password=hunter2')
          },
        }),
      ],
    })
    const res = await fetch(`${base}/boom`)
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    })
    expect(text).not.toContain('hunter2')
  })

  it('maps an undecodable path parameter to 400, not a 500 server error', async () => {
    const base = await boot({
      routes: [
        route({
          method: 'GET',
          url: '/items/:id',
          async handler({ params }) {
            return params
          },
        }),
      ],
    })
    const res = await fetch(`${base}/items/%E0%A4%A`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Malformed request path.' },
    })
  })
})
