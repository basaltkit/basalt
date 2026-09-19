/**
 * Shared adapter parity matrix for `upload()` bodies (BK-006), keyed per-route
 * rate limits (BK-008) and structured error details (BK-021). Not a test file
 * on its own: each adapter package (fastify, express, hono) runs it against its
 * own driver, so the three are held to the exact same assertions.
 */
import { ctx, definePlugin, ensureMetadata, type BasaltPlugin } from '@basaltkit/core'
import {
  HttpError,
  MAX_ERROR_DETAILS_BYTES,
  route,
  securityPlugin,
  upload,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
} from '@basaltkit/http'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BOUNDARY, chunked, contentType, multipart } from './multipart-fixtures.js'

export interface ParityRequest {
  method: string
  url: string
  headers?: Record<string, string>
  /** One buffer is sent with a Content-Length; an array is streamed chunked, without one. */
  body?: Buffer | Buffer[]
}

export interface ParityResponse {
  status: number
  json: unknown
  headers: Record<string, string>
}

export type Send = (request: ParityRequest) => Promise<ParityResponse>

export interface ParityDriver {
  /** Boots the adapter with these routes (+ plugins) and returns a way to send requests. */
  boot(routes: BasaltRoute[], plugins: BasaltPlugin[]): Promise<Send>
  /** Tears down whatever `boot` started. */
  close(): Promise<void>
}

/** Sets `ctx().user` / `ctx().tenant` from headers (standing in for auth + tenancy) and guards `meta.signedIn`. */
const identity = (log: string[]) =>
  definePlugin({
    name: 'test:identity',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        log.push('enricher')
        const user = request.headers['x-user']
        const tenant = request.headers['x-tenant']
        if (typeof user === 'string' && user) context['user'] = { id: user }
        if (typeof tenant === 'string' && tenant) context['tenant'] = { id: tenant }
      }
      const guard: RouteGuard = ({ route: r, context }) => {
        log.push('guard')
        if (r.meta?.['signedIn'] === true && !context['user']) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in.')
      }
      ensureMetadata(container).add('http:enrichers', enricher)
      ensureMetadata(container).add('http:guards', guard)
    },
  })

const sample = multipart([
  { name: 'title', value: 'Contract' },
  { name: 'doc', filename: '../../etc/contract.pdf', type: 'application/pdf', data: '%PDF-1.7\r\nbody' },
  { name: 'img', filename: 'C:\\Users\\x\\scan.png', type: 'image/png', data: Buffer.from([0, 13, 10, 45, 45, 255]) },
])

export function uploadParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: upload() parity (BK-006)`, () => {
    const log: string[] = []
    let handled = 0

    const routes = [
      route({
        method: 'POST',
        url: '/files',
        body: upload({ maxBytes: 64 * 1024, maxFiles: 2, allowedTypes: ['application/pdf', 'image/*'] }),
        meta: { signedIn: true },
        async handler({ body }) {
          log.push('handler')
          handled += 1
          const files: unknown[] = []
          for await (const file of body.files) {
            let size = 0
            for await (const chunk of file.stream) size += (chunk as Buffer).length
            files.push({ field: file.field, filename: file.filename, type: file.declaredType, size })
          }
          return { user: (ctx()['user'] as { id: string }).id, fields: { ...body.fields }, files }
        },
      }),
      route({
        method: 'POST',
        url: '/ignore',
        body: upload({ maxBytes: 64 * 1024, maxFiles: 5 }),
        handler: () => ({ ignored: true }),
      }),
      route({
        method: 'POST',
        url: '/limited',
        body: upload({ maxBytes: 64 * 1024, maxFiles: 1 }),
        meta: { rateLimit: { limit: 1, windowMs: 60_000, key: 'user' } },
        async handler({ body }) {
          for await (const file of body.files) file.stream.resume()
          return { ok: true }
        },
      }),
      route({ method: 'GET', url: '/ping', handler: () => ({ pong: true }) }),
    ]

    let send: Send
    const boot = async () => {
      log.length = 0
      handled = 0
      send = await driver.boot(routes, [
        identity(log),
        securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false }),
      ])
    }
    afterEach(() => driver.close())

    const post = (url: string, body: Buffer | Buffer[], headers: Record<string, string> = {}) =>
      send({ method: 'POST', url, body, headers: { 'content-type': contentType(), 'x-user': 'alice', ...headers } })

    it('streams fields and files to the handler, with sanitised filenames', async () => {
      await boot()
      for (const body of [sample, chunked(sample, 7)]) {
        const res = await post('/files', body)
        expect(res.status).toBe(200)
        expect(res.json).toEqual({
          user: 'alice',
          fields: { title: 'Contract' },
          files: [
            { field: 'doc', filename: 'contract.pdf', type: 'application/pdf', size: 14 },
            { field: 'img', filename: 'scan.png', type: 'image/png', size: 6 },
          ],
        })
      }
    })

    it('runs enrichers and guards before reading the body: an unauthenticated upload gets 401', async () => {
      await boot()
      const res = await post('/files', sample, { 'x-user': '' })
      expect(res.status).toBe(401)
      expect(handled).toBe(0)
      expect(log).toEqual(['enricher', 'guard'])
      // The connection is not left hanging: the next request is served.
      expect((await send({ method: 'GET', url: '/ping' })).status).toBe(200)
    })

    it('413 when the declared Content-Length exceeds maxBytes', async () => {
      await boot()
      const big = multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: Buffer.alloc(80 * 1024, 1) }])
      const res = await post('/files', big)
      expect(res.status).toBe(413)
      expect(handled).toBe(0)
    })

    it('413 on the bytes received when the body is streamed without a length', async () => {
      await boot()
      const big = multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: Buffer.alloc(80 * 1024, 1) }])
      const res = await post('/files', chunked(big, 16 * 1024))
      expect(res.status).toBe(413)
      expect((res.json as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
    })

    it('400 on too many files, 415 on a disallowed type, 400 on a missing boundary, 415 on JSON', async () => {
      await boot()
      const three = multipart([
        { name: 'a', filename: 'a.pdf', type: 'application/pdf', data: '1' },
        { name: 'b', filename: 'b.pdf', type: 'application/pdf', data: '2' },
        { name: 'c', filename: 'c.pdf', type: 'application/pdf', data: '3' },
      ])
      const tooMany = await post('/files', three)
      expect([tooMany.status, (tooMany.json as { error: { code: string } }).error.code]).toEqual([400, 'TOO_MANY_FILES'])
      const html = multipart([{ name: 'a', filename: 'a.html', type: 'text/html', data: '<script>' }])
      expect((await post('/files', html)).status).toBe(415)
      expect((await post('/files', sample, { 'content-type': 'multipart/form-data' })).status).toBe(400)
      expect((await post('/files', Buffer.from('{"a":1}'), { 'content-type': 'application/json' })).status).toBe(415)
    })

    it('400 when the upload ends before the closing boundary', async () => {
      await boot()
      const truncated = multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: 'partial' }], { close: false })
      const res = await post('/files', chunked(truncated, 9))
      expect(res.status).toBe(400)
      expect((res.json as { error: { code: string } }).error.code).toBe('MALFORMED_MULTIPART')
    })

    it('400 on a boundary injected twice in the Content-Type', async () => {
      await boot()
      const res = await post('/files', sample, { 'content-type': `multipart/form-data; boundary=${BOUNDARY}; boundary=x` })
      expect(res.status).toBe(400)
    })

    it('answers (and keeps serving) when the handler never reads the upload', async () => {
      await boot()
      const res = await post('/ignore', chunked(sample, 11))
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ ignored: true })
      expect((await send({ method: 'GET', url: '/ping' })).status).toBe(200)
    })

    it('rate limits an upload route per user (meta.rateLimit.key) before reading the body', async () => {
      await boot()
      const one = multipart([{ name: 'doc', filename: 'a.pdf', type: 'application/pdf', data: 'x' }])
      expect((await post('/limited', one, { 'x-user': 'alice' })).status).toBe(200)
      expect((await post('/limited', one, { 'x-user': 'alice' })).status).toBe(429)
      expect((await post('/limited', one, { 'x-user': 'bob' })).status).toBe(200)
    })
  })
}

export function rateLimitKeyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: meta.rateLimit.key parity (BK-008)`, () => {
    const keyed = (url: string, key: unknown) =>
      route({ method: 'GET', url, meta: { rateLimit: { limit: 1, windowMs: 60_000, key } }, handler: () => ({ ok: true }) })
    const routes = [keyed('/by-user', 'user'), keyed('/by-tenant', 'tenant'), keyed('/by-ip', 'ip')]
    let send: Send
    afterEach(() => driver.close())

    const get = (url: string, user?: string, tenant?: string) =>
      send({
        method: 'GET',
        url,
        headers: { ...(user ? { 'x-user': user } : {}), ...(tenant ? { 'x-tenant': tenant } : {}) },
      }).then((r) => r.status)

    it('separates two users behind the same IP, shares a tenant, keeps IP as the default', async () => {
      send = await driver.boot(routes, [identity([]), securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false })])
      expect(await get('/by-user', 'alice')).toBe(200)
      expect(await get('/by-user', 'alice')).toBe(429)
      expect(await get('/by-user', 'bob')).toBe(200)

      expect(await get('/by-tenant', 'alice', 'acme')).toBe(200)
      expect(await get('/by-tenant', 'bob', 'acme')).toBe(429)
      expect(await get('/by-tenant', 'carol', 'globex')).toBe(200)

      expect(await get('/by-ip', 'alice')).toBe(200)
      expect(await get('/by-ip', 'bob')).toBe(429)
    })

    it('falls back to the IP when there is no user', async () => {
      send = await driver.boot(routes, [identity([]), securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false })])
      expect(await get('/by-user')).toBe(200)
      expect(await get('/by-user')).toBe(429)
      expect(await get('/by-user', 'alice')).toBe(200)
    })
  })
}

export function errorDetailsParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: structured error details parity (BK-021)`, () => {
    const details = { failed: ['age', 'address'], remaining: 2, conflict: { field: 'email', version: 7 } }
    const routes = [
      route({
        method: 'GET',
        url: '/checks',
        handler: () => {
          throw new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', { details })
        },
      }),
      route({
        method: 'GET',
        url: '/legacy',
        handler: () => {
          throw new HttpError(409, 'CONFLICT', 'Already exists.')
        },
      }),
      route({
        method: 'GET',
        url: '/unsafe',
        handler: () => {
          throw new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
            details: { blob: 'x'.repeat(MAX_ERROR_DETAILS_BYTES * 2) },
          })
        },
      }),
      route({
        method: 'GET',
        url: '/boom',
        handler: () => {
          throw Object.assign(new Error('internals'), { details: { secret: 'shhh' } })
        },
      }),
      route({
        method: 'GET',
        url: '/validated',
        query: z.object({ page: z.coerce.number() }),
        handler: ({ query }) => query,
      }),
    ]

    let send: Send
    afterEach(() => driver.close())
    const get = (url: string) => send({ method: 'GET', url })

    it('serves the same 422-with-details body on every adapter', async () => {
      send = await driver.boot(routes, [])
      const res = await get('/checks')
      expect(res.status).toBe(422)
      expect(res.json).toEqual({ error: { code: 'CHECKS_FAILED', message: 'Checks failed.', details } })
    })

    it('adds no details key to a 3-argument HttpError, an oversized payload, or an unexpected 500', async () => {
      send = await driver.boot(routes, [])
      expect(await get('/legacy')).toMatchObject({
        status: 409,
        json: { error: { code: 'CONFLICT', message: 'Already exists.' } },
      })
      expect((await get('/legacy')).json).toEqual({ error: { code: 'CONFLICT', message: 'Already exists.' } })
      expect((await get('/unsafe')).json).toEqual({ error: { code: 'CHECKS_FAILED', message: 'Checks failed.' } })
      const boom = await get('/boom')
      expect(boom.status).toBe(500)
      expect(boom.json).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
    })

    it('leaves the validation body untouched — part and issues, still no details', async () => {
      send = await driver.boot(routes, [])
      const res = await get('/validated?page=abc')
      expect(res.status).toBe(400)
      expect(res.json).toMatchObject({ error: { code: 'HTTP_VALIDATION', part: 'query' } })
      const body = res.json as { error: Record<string, unknown> }
      expect(Array.isArray(body.error['issues'])).toBe(true)
      expect('details' in body.error).toBe(false)
    })
  })
}

/** Sends a request over real HTTP with fetch (Fastify/Express listen on a port). */
export async function fetchSend(base: string, request: ParityRequest): Promise<ParityResponse> {
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers: request.headers ?? {} }
  if (Array.isArray(request.body)) {
    const chunks = request.body
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
  }
  const res = await fetch(`${base}${request.url}`, init)
  const raw = await res.text()
  let json: unknown = raw
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) }
}
