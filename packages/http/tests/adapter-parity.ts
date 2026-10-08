/**
 * Shared adapter parity matrix for `upload()` bodies (BK-006), keyed per-route
 * rate limits (BK-008), structured error details (BK-021), streaming
 * responses (BK-019), `rawBody()` bodies (BK-029), the route table (BK-025), CORS preflights (FA-015),
 * enricher reply headers (BK-083) and
 * wire-level behaviour (FA-077…FA-080). Not a test file on its own: each adapter package
 * (fastify, express, hono) runs it against its own driver, so the three are
 * held to the exact same assertions.
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { ctx, definePlugin, ensureMetadata, MetricsRegistry, type BasaltPlugin } from '@basaltkit/core'
import {
  describeRoutes,
  findUnguardedRoutes,
  generateOpenApi,
  GUARDED_META_BUCKET,
  HTTP_SERVER,
  HttpError,
  idempotencyPlugin,
  InvalidRouteMetaError,
  META_VALIDATORS_BUCKET,
  metricsPlugin,
  openapiPlugin,
  sse,
  MAX_ERROR_DETAILS_BYTES,
  rawBody,
  route,
  securityPlugin,
  stream,
  upload,
  type BasaltRoute,
  type HttpErrorReport,
  type HttpErrorReporter,
  type RequestEnricher,
  type RouteGuard,
  type RouteMetaValidator,
  type RouteTableEntry,
} from '@basaltkit/http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BOUNDARY, chunked, contentType, multipart } from './multipart-fixtures.js'

export interface ParityRequest {
  method: string
  url: string
  headers?: Record<string, string>
  /** One buffer is sent with a Content-Length; an array is streamed chunked, without one. */
  body?: Buffer | Buffer[]
  /** Aborting it stands in for the client disconnecting mid-response. */
  signal?: AbortSignal
}

export interface ParityResponse {
  status: number
  json: unknown
  headers: Record<string, string>
  /** The raw body, for responses that are not JSON (a streamed download). */
  bytes: Buffer
}

/** Sends a request and hands back the untouched `Response` — body still unread. */
export type Fetcher = (request: ParityRequest) => Promise<Response>

export interface Send {
  (request: ParityRequest): Promise<ParityResponse>
  /** The raw `Response`, so a test can read the body chunk by chunk or abort it. */
  raw: Fetcher
}

/** Options every adapter plugin honours, so a suite can observe what was reported. */
export interface ParityOptions {
  onError?: HttpErrorReporter
}

export interface ParityDriver {
  /** Boots the adapter with these routes (+ plugins) and returns a way to send requests. */
  boot(routes: BasaltRoute[], plugins: BasaltPlugin[], options?: ParityOptions): Promise<Send>
  /** Tears down whatever `boot` started. */
  close(): Promise<void>
}

/** Wraps a raw fetcher as the `Send` the suites use. */
export function sendWith(fetcher: Fetcher): Send {
  const send = async (request: ParityRequest): Promise<ParityResponse> => {
    const res = await fetcher(request)
    const bytes = Buffer.from(await res.arrayBuffer())
    const raw = bytes.toString('utf8')
    let json: unknown = raw
    try {
      json = raw ? JSON.parse(raw) : undefined
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()), bytes }
  }
  send.raw = fetcher
  return send
}

/** Sets `ctx().user` / `ctx().tenant` / `ctx().apiKey` from headers (standing in for auth + tenancy + API keys) and guards `meta.signedIn`. */
const identity = (log: string[]) =>
  definePlugin({
    name: 'test:identity',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        log.push('enricher')
        const user = request.headers['x-user']
        const tenant = request.headers['x-tenant']
        const key = request.headers['x-key']
        // Untyped on purpose: a package whose tests load @basaltkit/auth types
        // `ctx().user` as its full user, which this stand-in does not build.
        const scope = context as unknown as Record<string, unknown>
        if (typeof user === 'string' && user) scope['user'] = { id: user }
        if (typeof tenant === 'string' && tenant) scope['tenant'] = { id: tenant }
        if (typeof key === 'string' && key) scope['apiKey'] = { id: key, scopes: ['*'] }
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

/**
 * A body whose bytes cannot survive a parse-and-re-serialise round trip: keys
 * out of alphabetical order, irregular whitespace, a number that re-prints
 * differently, and an escape a serialiser would normalise. `JSON.stringify` of
 * the parsed object differs from this at the first byte — which is exactly why
 * a signature computed over it fails against every real provider.
 */
const AWKWARD_JSON = Buffer.from(
  '{  "zeta" : 1.50,\n\t"alpha":"caf\\u00e9",  "nested":{ "b":2,"a":1 } }',
  'utf8',
)

export function rawBodyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: rawBody() parity (BK-029)`, () => {
    const order: string[] = []
    const routes = [
      route({
        method: 'POST',
        url: '/hook',
        body: rawBody({ maxBytes: 1024 }),
        async handler({ body }) {
          order.push('handler')
          return {
            hex: body.bytes.toString('hex'),
            length: body.bytes.length,
            contentType: body.contentType ?? null,
            contentLength: body.contentLength ?? null,
            text: body.text(),
          }
        },
      }),
      route({
        method: 'POST',
        url: '/guarded-hook',
        body: rawBody({ maxBytes: 1024 * 1024 }),
        meta: { signedIn: true },
        async handler({ body }) {
          order.push('handler')
          return { length: body.bytes.length }
        },
      }),
      // A neighbour on the same app, parsed the ordinary way: a rawBody()
      // route must not change how anything else is served.
      route({
        method: 'POST',
        url: '/json',
        body: z.object({ a: z.number() }),
        handler: ({ body }) => ({ parsed: body }),
      }),
    ]
    let send: Send
    afterEach(() => driver.close())

    const boot = async () => {
      order.length = 0
      send = await driver.boot(routes, [identity(order)])
    }
    const post = (url: string, body: Buffer | Buffer[], headers: Record<string, string> = {}) =>
      send({ method: 'POST', url, body, headers })

    it('hands the handler byte-identical JSON', async () => {
      await boot()
      const payload = Buffer.from('{"id":"evt_1","type":"payment.failed"}', 'utf8')
      const res = await post('/hook', payload, { 'content-type': 'application/json' })
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({
        hex: payload.toString('hex'),
        length: payload.length,
        contentType: 'application/json',
        text: payload.toString('utf8'),
      })
    })

    it('preserves whitespace and key order a re-serialisation would destroy', async () => {
      await boot()
      const res = await post('/hook', AWKWARD_JSON, { 'content-type': 'application/json; charset=utf-8' })
      expect(res.status).toBe(200)
      const got = res.json as { hex: string; text: string; contentType: string }
      expect(got.hex).toBe(AWKWARD_JSON.toString('hex'))
      // The whole point: these bytes are NOT what a parse + stringify yields.
      expect(got.text).not.toBe(JSON.stringify(JSON.parse(AWKWARD_JSON.toString('utf8'))))
      // The parameters are stripped from the essence, the bytes are not touched.
      expect(got.contentType).toBe('application/json')
    })

    it('hands over a non-JSON body untouched, including bytes that are not text', async () => {
      await boot()
      const payload = Buffer.from([0x00, 0x1f, 0x7b, 0xff, 0xfe, 0x0a, 0x0d])
      const res = await post('/hook', payload, { 'content-type': 'application/octet-stream' })
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({
        hex: payload.toString('hex'),
        length: payload.length,
        contentType: 'application/octet-stream',
      })
    })

    it('accepts a body sent without a Content-Length (chunked)', async () => {
      await boot()
      const parts = [Buffer.from('{"a":'), Buffer.from('1}')]
      const res = await post('/hook', parts, { 'content-type': 'application/json' })
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ hex: Buffer.concat(parts).toString('hex'), contentLength: null })
    })

    it('answers 413 over maxBytes — declared or actually sent', async () => {
      await boot()
      const declared = await post('/hook', Buffer.alloc(4096, 0x61), { 'content-type': 'application/json' })
      expect(declared.status).toBe(413)
      expect((declared.json as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
      // No Content-Length at all: the cap has to hold on the bytes received.
      const streamed = await post('/hook', [Buffer.alloc(2048, 0x61), Buffer.alloc(2048, 0x61)], {
        'content-type': 'application/json',
      })
      expect(streamed.status).toBe(413)
      expect(order).not.toContain('handler')
    })

    it('runs the guards before the body is read', async () => {
      await boot()
      // Large enough that a body read before the guards would answer 413
      // (Hono's bounded pre-read) or hand the handler something; the guard has
      // to win, and the handler must never run.
      const res = await post('/guarded-hook', Buffer.alloc(300 * 1024, 0x61), {
        'content-type': 'application/json',
      })
      expect(res.status).toBe(401)
      expect((res.json as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')
      expect(order).toEqual(['enricher', 'guard'])
      // The connection is closed rather than left waiting on an unread body.
      expect(order).not.toContain('handler')
      const ok = await post('/guarded-hook', Buffer.from('{"a":1}'), {
        'content-type': 'application/json',
        'x-user': 'alice',
      })
      expect(ok.status).toBe(200)
      expect(ok.json).toEqual({ length: 7 })
    })

    it('leaves neighbouring JSON routes parsed exactly as before', async () => {
      await boot()
      const parsed = await post('/json', Buffer.from('{"a":1}'), { 'content-type': 'application/json' })
      expect(parsed.status).toBe(200)
      expect(parsed.json).toEqual({ parsed: { a: 1 } })
      // Still validated, and still a 400 when it does not fit the schema.
      const bad = await post('/json', Buffer.from('{"a":"x"}'), { 'content-type': 'application/json' })
      expect(bad.status).toBe(400)
      // And a rawBody() route in the same app did not turn the JSON one into
      // a raw one: the handler saw an object, not bytes.
      const again = await post('/hook', Buffer.from('{"a":1}'), { 'content-type': 'application/json' })
      expect((again.json as { hex: string }).hex).toBe(Buffer.from('{"a":1}').toString('hex'))
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

/**
 * BK-083 (g): per-API-key budgets, several budgets per route, shared buckets
 * and path-prefix edge budgets behave identically on every adapter.
 */
export function rateLimitBucketsParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: rate-limit buckets parity (BK-083 g)`, () => {
    let send: Send
    afterEach(() => driver.close())
    const ok = () => ({ ok: true })
    const call = async (url: string, headers: Record<string, string> = {}, method = 'GET') => {
      const res = await send({ method, url, headers })
      return {
        status: res.status,
        limit: res.headers['x-ratelimit-limit'],
        remaining: res.headers['x-ratelimit-remaining'],
        retryAfter: res.headers['retry-after'],
      }
    }
    const boot = (routes: BasaltRoute[], rateLimit: Parameters<typeof securityPlugin>[0] = {}) =>
      driver.boot(routes, [identity([]), securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false, ...rateLimit })])

    it("key 'apiKey': two keys behind one IP get separate budgets", async () => {
      send = await boot([route({ method: 'GET', url: '/k', meta: { rateLimit: { limit: 1, windowMs: 60_000, key: 'apiKey' } }, handler: ok })])
      expect((await call('/k', { 'x-key': 'k1' })).status).toBe(200)
      expect((await call('/k', { 'x-key': 'k1' })).status).toBe(429)
      expect((await call('/k', { 'x-key': 'k2' })).status).toBe(200)
    })

    it('an array enforces every budget; headers follow the most constraining, Retry-After the refusing one', async () => {
      send = await boot([
        route({
          method: 'GET',
          url: '/multi',
          meta: {
            rateLimit: [
              { limit: 3, windowMs: 1_000, key: 'apiKey' },
              { limit: 2, windowMs: 60_000, key: 'tenant' },
            ],
          },
          handler: ok,
        }),
      ])
      const who = { 'x-key': 'k1', 'x-tenant': 't1' }
      expect(await call('/multi', who)).toEqual({ status: 200, limit: '2', remaining: '1', retryAfter: undefined })
      expect(await call('/multi', who)).toEqual({ status: 200, limit: '2', remaining: '0', retryAfter: undefined })
      expect(await call('/multi', who)).toEqual({ status: 429, limit: '2', remaining: '0', retryAfter: '60' })
    })

    it('a shared bucket is one counter across routes', async () => {
      const daily = { limit: 2, windowMs: 86_400_000, key: 'tenant', bucket: 'daily' }
      send = await boot([
        route({ method: 'GET', url: '/a', meta: { rateLimit: daily }, handler: ok }),
        route({ method: 'POST', url: '/b', meta: { rateLimit: [daily] }, handler: ok }),
      ])
      expect((await call('/a', { 'x-tenant': 't1' })).status).toBe(200)
      expect((await call('/b', { 'x-tenant': 't1' }, 'POST')).status).toBe(200)
      expect((await call('/a', { 'x-tenant': 't1' })).status).toBe(429)
      expect((await call('/a', { 'x-tenant': 't2' })).status).toBe(200)
    })

    it('a conflicting shared bucket refuses the boot', async () => {
      const boot2 = boot([
        route({ method: 'GET', url: '/a', meta: { rateLimit: { limit: 2, windowMs: 1_000, bucket: 'b' } }, handler: ok }),
        route({ method: 'GET', url: '/b', meta: { rateLimit: { limit: 3, windowMs: 1_000, bucket: 'b' } }, handler: ok }),
      ])
      await expect(boot2).rejects.toBeInstanceOf(InvalidRouteMetaError)
    })

    it('a malformed array refuses the boot', async () => {
      await expect(boot([route({ method: 'GET', url: '/a', meta: { rateLimit: [] }, handler: ok })])).rejects.toBeInstanceOf(
        InvalidRouteMetaError,
      )
    })

    it('a path prefix lifts the global per-IP ceiling for its family of paths', async () => {
      send = await boot(
        [route({ method: 'GET', url: '/v1/orders', handler: ok }), route({ method: 'GET', url: '/app', handler: ok })],
        { rateLimit: { limit: 2, windowMs: 60_000, prefixes: [{ prefix: '/v1', limit: 5, windowMs: 60_000 }] } },
      )
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) statuses.push((await call('/v1/orders')).status)
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
      expect((await call('/V1/Orders?x=1')).limit).toBe('5')
      expect((await call('/app')).limit).toBe('2')
    })
  })
}

/** The served OpenAPI document is the same on every adapter. */
export function openApiParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: OpenAPI document parity (BK-083 h)`, () => {
    afterEach(() => driver.close())
    it('serves the same /openapi.json', async () => {
      const routes = [
          route({ method: 'GET', url: '/orders', meta: { scopes: ['orders:read'], tags: ['orders'] }, handler: () => [] }),
          route({ method: 'POST', url: '/orders', meta: { scopes: ['orders:write'] }, body: z.object({ sku: z.string() }), handler: () => ({}) }),
          route({ method: 'GET', url: '/me', meta: { auth: true }, handler: () => ({}) }),
          route({ method: 'GET', url: '/session-only', meta: { auth: true, apiKey: false }, handler: () => ({}) }),
          route({ method: 'GET', url: '/public', handler: () => ({}) }),
      ]
      const info = { title: 'Parity', version: '1.0.0' }
      const apiKey = { header: 'x-api-key', onAuthRoutes: true }
      // Stands in for authPlugin + apiKeysPlugin, which claim these keys.
      const claims = definePlugin({
        name: 'test:openapi-claims',
        register({ container }) {
          ensureMetadata(container).add(GUARDED_META_BUCKET, 'auth')
          ensureMetadata(container).add(GUARDED_META_BUCKET, 'scopes')
        },
      })
      const send = await driver.boot(routes, [claims, idempotencyPlugin(), openapiPlugin({ info, apiKey })])
      const doc = (await send({ method: 'GET', url: '/openapi.json' })).json as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(doc['paths']['/orders']['get']['security']).toEqual([{ apiKeyAuth: [] }])
      expect(doc['paths']['/orders']['post']['x-required-scopes']).toEqual(['orders:write'])
      expect(doc['paths']['/orders']['post']['parameters'][0]['name']).toBe('Idempotency-Key')
      expect(doc['paths']['/me']['get']['security']).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }])
      expect(doc['paths']['/session-only']['get']['security']).toEqual([{ bearerAuth: [] }])
      expect(doc['paths']['/public']['get']['security']).toBeUndefined()
      // The whole document equals the adapter-free generation: any
      // adapter-specific drift fails here, on every adapter alike.
      const expected = generateOpenApi(
        routes.map((r) => ({ method: r.method, url: r.url, meta: r.meta ?? {}, ...(r.body ? { body: r.body } : {}) })),
        info,
        [],
        { apiKey, idempotency: { header: 'Idempotency-Key', methods: ['POST'] } },
      )
      expect(doc).toEqual(JSON.parse(JSON.stringify(expected)))
    })
  })
}

export function rateLimitWarningParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: unenforced meta.rateLimit warns at boot (BK-046)`, () => {
    const routes = [route({ method: 'GET', url: '/budgeted', meta: { rateLimit: { limit: 1, windowMs: 60_000 } }, handler: () => ({ ok: true }) })]
    const warnings = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('meta.rateLimit'))
    afterEach(async () => {
      vi.restoreAllMocks()
      await driver.close()
    })

    it('warns once, naming the route, when no rate limiter is registered — and still serves', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const send = await driver.boot(routes, [])
      expect(warnings(warn)).toHaveLength(1)
      expect(warnings(warn)[0]).toContain('GET /budgeted')
      expect((await send({ method: 'GET', url: '/budgeted' })).status).toBe(200)
    })

    it('stays quiet when securityPlugin({ rateLimit }) enforces it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await driver.boot(routes, [securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false })])
      expect(warnings(warn)).toHaveLength(0)
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
      route({
        method: 'GET',
        url: '/internal',
        handler: () => {
          throw new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
            details: { failed: ['age'] },
            internalDetails: { upstream: 'kyc', reply: 'account 991 frozen' },
          })
        },
      }),
      route({
        method: 'GET',
        url: '/internal-500',
        handler: () => {
          throw new HttpError(500, 'BROKEN', 'Broken.', { internalDetails: { job: 'job-7-frozen' } })
        },
      }),
    ]

    let send: Send
    afterEach(() => driver.close())
    const get = (url: string) => send({ method: 'GET', url })

    it('keeps internalDetails out of the body but hands them to the reporter (FA-H05)', async () => {
      const reports: HttpErrorReport[] = []
      send = await driver.boot(routes, [], { onError: (report) => reports.push(report) })
      const res = await get('/internal')
      expect(res.status).toBe(422)
      expect(res.json).toEqual({ error: { code: 'CHECKS_FAILED', message: 'Checks failed.', details: { failed: ['age'] } } })
      expect(res.bytes.toString('utf8')).not.toContain('frozen')
      const fatal = await get('/internal-500')
      expect(fatal.status).toBe(500)
      expect(fatal.bytes.toString('utf8')).not.toContain('frozen')
      const internals = reports.map((r) => (r.error as { internalDetails?: unknown }).internalDetails)
      expect(internals).toEqual([{ upstream: 'kyc', reply: 'account 991 frozen' }, { job: 'job-7-frozen' }])
    })

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

/** 64 KiB of a deterministic pattern — a wrong byte anywhere shows up in the digest. */
const CHUNK = Buffer.from(Uint8Array.from({ length: 64 * 1024 }, (_, i) => (i * 31 + 7) % 251))
/** Exactly 48 chunks (3 MiB): big enough that nothing can quietly buffer it whole. */
const DOWNLOAD_BYTES = 48 * CHUNK.length
/** 256 chunks (16 MiB): far past any socket or fetch buffer, so a stalled reader stalls the source. */
const BIG_BYTES = 256 * CHUNK.length
const DOWNLOAD_DIGEST = createHash('sha256')
  .update(Buffer.concat(Array.from({ length: 48 }, () => CHUNK)))
  .digest('hex')

/** A source that records how much it produced and whether it was destroyed. */
class CountingSource extends Readable {
  produced = 0
  constructor(private remaining: number) {
    super({ highWaterMark: CHUNK.length })
  }
  override _read(): void {
    if (this.remaining <= 0) {
      this.push(null)
      return
    }
    const size = Math.min(CHUNK.length, this.remaining)
    this.remaining -= size
    this.produced += size
    this.push(size === CHUNK.length ? CHUNK : CHUNK.subarray(0, size))
  }
}

/** A source that hands over `before` chunks and then fails. */
class FailingSource extends Readable {
  private sent = 0
  constructor(private readonly before: number) {
    super({ highWaterMark: CHUNK.length })
  }
  override _read(): void {
    if (this.sent >= this.before) {
      this.destroy(new Error('source exploded'))
      return
    }
    this.sent += 1
    this.push(CHUNK)
  }
}

const settle = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`)
    await settle()
  }
}

/** Reads a response body to the end; rejects the way a cut connection does. */
async function readAll(response: Response): Promise<{ bytes: Buffer; failed: unknown }> {
  const reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    return { bytes: Buffer.concat(chunks), failed: undefined }
  } catch (error) {
    return { bytes: Buffer.concat(chunks), failed: error }
  }
}

/**
 * Streaming responses (`stream()`): every adapter must send the bytes without
 * buffering them, honour backpressure, and — this is the part that matters —
 * never leak the source when things go wrong.
 */
export function streamParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: stream() parity (BK-019)`, () => {
    const sources: { download?: CountingSource; big?: CountingSource } = {}
    const reports: HttpErrorReport[] = []
    const onError: HttpErrorReporter = (entry) => {
      reports.push(entry)
    }

    const routes = [
      route({
        method: 'GET',
        url: '/download',
        meta: { etag: true },
        handler() {
          const source = new CountingSource(DOWNLOAD_BYTES)
          sources.download = source
          return stream(source, {
            contentType: 'application/pdf',
            contentLength: DOWNLOAD_BYTES,
            filename: '../relatório "final".pdf',
          })
        },
      }),
      route({
        method: 'GET',
        url: '/big',
        handler() {
          const source = new CountingSource(BIG_BYTES)
          sources.big = source
          return stream(source, { contentType: 'application/octet-stream' })
        },
      }),
      route({
        method: 'GET',
        url: '/guarded',
        handler() {
          throw new HttpError(423, 'FILE_NOT_SCANNED', 'Quarantined.')
        },
      }),
      route({ method: 'GET', url: '/fail-first', handler: () => stream(new FailingSource(0)) }),
      route({ method: 'GET', url: '/fail-later', handler: () => stream(new FailingSource(2)) }),
      route({ method: 'GET', url: '/empty', handler: () => stream(Readable.from([]), { contentType: 'text/plain' }) }),
    ]

    let send: Send
    const boot = async () => {
      reports.length = 0
      delete sources.download
      delete sources.big
      send = await driver.boot(routes, [], { onError })
    }
    afterEach(() => driver.close())

    it('streams a multi-MiB body through intact, with Content-Length and Content-Disposition', async () => {
      await boot()
      const res = await send({ method: 'GET', url: '/download' })
      expect(res.status).toBe(200)
      expect(res.bytes.length).toBe(DOWNLOAD_BYTES)
      expect(createHash('sha256').update(res.bytes).digest('hex')).toBe(DOWNLOAD_DIGEST)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['content-length']).toBe(String(DOWNLOAD_BYTES))
      // Sanitised (no `../`), quoted ASCII fallback plus the RFC 5987 form.
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="relat_rio _final_.pdf"; filename*=UTF-8''relat%C3%B3rio%20%22final%22.pdf`,
      )
      // A streamed body is not a payload to hash: `meta.etag` must stay out of it.
      expect(res.headers['etag']).toBeUndefined()
      expect(reports).toEqual([])
    })

    it('sends no body for HEAD, keeps the headers, and reads nothing from the source', async () => {
      await boot()
      const res = await send({ method: 'HEAD', url: '/download' })
      expect(res.status).toBe(200)
      expect(res.bytes.length).toBe(0)
      expect(res.headers['content-type']).toBe('application/pdf')
      expect(res.headers['content-length']).toBe(String(DOWNLOAD_BYTES))
      expect(sources.download?.produced).toBe(0)
      expect(sources.download?.destroyed).toBe(true)
    })

    it('destroys the source when the client disconnects mid-download', async () => {
      await boot()
      const controller = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/big', signal: controller.signal })
      const reader = res.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      controller.abort()
      await until(() => sources.big?.destroyed === true, 'the source to be destroyed')
      // A disconnect is not a server fault — it must not be reported as one.
      expect(reports.filter((entry) => entry.status >= 500)).toEqual([])
    })

    it('backpressures: a client that stops reading stops the source', async () => {
      await boot()
      const controller = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/big', signal: controller.signal })
      const reader = res.body!.getReader()
      await reader.read()
      await settle(250)
      expect(sources.big!.produced).toBeGreaterThan(0)
      expect(sources.big!.produced).toBeLessThan(BIG_BYTES / 2)
      controller.abort()
      await until(() => sources.big?.destroyed === true, 'the source to be destroyed')
    })

    it('answers JSON when the handler refuses before the first byte', async () => {
      await boot()
      const res = await send({ method: 'GET', url: '/guarded' })
      expect(res.status).toBe(423)
      expect(res.json).toEqual({ error: { code: 'FILE_NOT_SCANNED', message: 'Quarantined.' } })
      expect(res.headers['content-type']).toContain('application/json')
    })

    it('answers JSON when the source fails before the first byte', async () => {
      await boot()
      const res = await send({ method: 'GET', url: '/fail-first' })
      expect(res.status).toBe(500)
      expect(res.json).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.headers['content-disposition']).toBeUndefined()
      // Reported once — not swallowed, not duplicated.
      expect(reports).toHaveLength(1)
      expect(reports[0]!.status).toBe(500)
    })

    it('cuts the connection — never appends an error body — when the source fails after the headers', async () => {
      await boot()
      const res = await send.raw({ method: 'GET', url: '/fail-later' })
      expect(res.status).toBe(200)
      const { bytes, failed } = await readAll(res)
      expect(failed).toBeDefined()
      // Whatever arrived is the real payload, byte for byte: no JSON tacked on.
      expect(bytes.length).toBeLessThanOrEqual(2 * CHUNK.length)
      expect(bytes.equals(Buffer.concat([CHUNK, CHUNK]).subarray(0, bytes.length))).toBe(true)
      await until(() => reports.length > 0, 'the failure to be reported')
      await settle(50)
      expect(reports).toHaveLength(1)
      expect(reports[0]!.status).toBe(500)
    })

    it('serves an empty source as an empty 200', async () => {
      await boot()
      const res = await send({ method: 'GET', url: '/empty' })
      expect(res.status).toBe(200)
      expect(res.bytes.length).toBe(0)
      expect(res.headers['content-type']).toBe('text/plain')
    })
  })
}

export function corsPreflightParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: CORS preflight parity (FA-015)`, () => {
    const routes = [route({ method: 'GET', url: '/x', handler: () => ({ ok: true }) })]
    afterEach(() => driver.close())
    const preflight = (origin: string, url = '/x') => ({
      method: 'OPTIONS',
      url,
      headers: { origin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'x-custom' },
    })

    it('counts preflights against the global rate limit', async () => {
      const send = await driver.boot(routes, [
        securityPlugin({ rateLimit: { limit: 2, windowMs: 60_000 }, cors: { origin: true }, headers: false }),
      ])
      const first = await send(preflight('https://app.test'))
      expect(first.status).toBe(204)
      expect(first.headers['x-ratelimit-limit']).toBe('2')
      expect((await send(preflight('https://app.test'))).status).toBe(204)
      expect((await send(preflight('https://app.test'))).status).toBe(429)
      // The budget is shared: the real request that follows is limited too.
      expect((await send({ method: 'GET', url: '/x' })).status).toBe(429)
    })

    it('discloses no Allow-* headers to an origin that is not allowed', async () => {
      const send = await driver.boot(routes, [securityPlugin({ cors: { origin: ['https://good.test'] }, headers: false })])
      const evil = await send(preflight('https://evil.test'))
      expect(evil.status).toBe(204)
      expect(evil.headers['access-control-allow-origin']).toBeUndefined()
      expect(evil.headers['access-control-allow-methods']).toBeUndefined()
      expect(evil.headers['access-control-allow-headers']).toBeUndefined()
      expect(evil.headers['access-control-max-age']).toBeUndefined()

      const good = await send(preflight('https://good.test'))
      expect(good.status).toBe(204)
      expect(good.headers['access-control-allow-origin']).toBe('https://good.test')
      expect(good.headers['access-control-allow-methods']).toContain('DELETE')
      expect(good.headers['access-control-allow-headers']).toBe('x-custom')
    })
  })
}


/**
 * Boot-time route-meta validation (FA-044 residual): every adapter runs the
 * validators plugins register in `http:meta-validators` over its full route
 * list and refuses to boot on a problem — before any traffic.
 */
export function metaValidatorParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: route-meta validators run at boot (FA-044 residual)`, () => {
    afterEach(() => driver.close())
    const seen: string[] = []
    const shapes = definePlugin({
      name: 'test:shape-validator',
      register({ container }) {
        const validator: RouteMetaValidator = ({ route: r }) => {
          seen.push(`${r.method} ${r.url}`)
          const shape = r.meta?.['shape']
          if (shape === undefined || shape === 'circle' || shape === 'square') return
          return `meta.shape ${JSON.stringify(shape)} is not a known shape`
        }
        ensureMetadata(container).add(META_VALIDATORS_BUCKET, validator)
      },
    })
    const ok = route({ method: 'GET', url: '/ok', meta: { shape: 'circle' }, handler: () => ({ ok: true }) })

    it('refuses to boot, naming every offending route, when a validator reports a problem', async () => {
      const bad = [
        ok,
        route({ method: 'GET', url: '/tri', meta: { shape: 'triangle' }, handler: () => 'x' }),
        route({ method: 'POST', url: '/hex', meta: { shape: 6 }, handler: () => 'x' }),
      ]
      const boot = driver.boot(bad, [shapes])
      await expect(boot).rejects.toBeInstanceOf(InvalidRouteMetaError)
      await boot.catch((error: InvalidRouteMetaError) => {
        expect(error.code).toBe('HTTP_INVALID_ROUTE_META')
        expect(error.problems).toEqual([
          { route: 'GET /tri', problem: 'meta.shape "triangle" is not a known shape' },
          { route: 'POST /hex', problem: 'meta.shape 6 is not a known shape' },
        ])
      })
    })

    it('a throwing validator is a problem too', async () => {
      const throwing = definePlugin({
        name: 'test:throwing-validator',
        register({ container }) {
          ensureMetadata(container).add(META_VALIDATORS_BUCKET, (() => {
            throw new Error('boom')
          }) satisfies RouteMetaValidator)
        },
      })
      await expect(driver.boot([ok], [throwing])).rejects.toThrow(/GET \/ok: boom/)
    })

    it('boots and serves when every route passes, having validated the full list', async () => {
      seen.length = 0
      const send = await driver.boot([ok, route({ method: 'GET', url: '/plain', handler: () => 'p' })], [shapes])
      expect(seen).toEqual(['GET /ok', 'GET /plain'])
      expect((await send({ method: 'GET', url: '/ok' })).json).toEqual({ ok: true })
    })
  })
}

/**
 * An enricher receives the reply, so one that refuses the request can set a
 * response header first (BK-083: `WWW-Authenticate` on a dead API key). The
 * header must survive the shared error envelope on every adapter.
 */
export function enricherReplyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: enricher reply headers on a refusal (BK-083)`, () => {
    afterEach(() => driver.close())
    const refusing = definePlugin({
      name: 'test:refusing-enricher',
      register({ container }) {
        const enricher: RequestEnricher = ({ request, reply }) => {
          if (request.headers['x-credential'] !== 'dead') return
          reply?.header('WWW-Authenticate', 'Bearer error="invalid_token"')
          throw new HttpError(401, 'TEST_CREDENTIAL_INVALID', 'Dead credential.')
        }
        ensureMetadata(container).add('http:enrichers', enricher)
      },
    })
    const ok = route({ method: 'GET', url: '/thing', handler: () => ({ ok: true }) })

    it('keeps the header set before the throw, with the standard error body', async () => {
      const send = await driver.boot([ok], [refusing])
      const res = await send({ method: 'GET', url: '/thing', headers: { 'x-credential': 'dead' } })
      expect(res.status).toBe(401)
      expect(res.json).toEqual({ error: { code: 'TEST_CREDENTIAL_INVALID', message: 'Dead credential.' } })
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"')
      const fine = await send({ method: 'GET', url: '/thing' })
      expect(fine.status).toBe(200)
      expect(fine.headers['www-authenticate']).toBeUndefined()
    })
  })
}

/** Sends requests over real HTTP with fetch (Fastify/Express listen on a port). */
export function httpFetcher(base: string): Fetcher {
  return (request) => {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers: request.headers ?? {},
      ...(request.signal ? { signal: request.signal } : {}),
    }
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
    }
    return fetch(`${base}${request.url}`, init)
  }
}


/** Reads the in-flight gauge straight from the registry (no /metrics request in flight). */
const inFlightOf = (registry: MetricsRegistry): number => {
  const line = registry
    .render()
    .split('\n')
    .find((entry) => entry.startsWith('http_requests_in_flight '))
  return Number(line?.split(' ')[1])
}

/** Polls until `read()` returns `want` (after-hooks may settle just after the client got the response). */
async function eventually(read: () => number, want: number, timeoutMs = 1_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (value !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    value = read()
  }
  return value
}

/**
 * Wire-level parity (FA-077…FA-080): what reaches the client for the same
 * route must not depend on the adapter — the Content-Type of a string, the
 * headers on an event stream, how a body is recognised as JSON and what a
 * malformed one answers, the shape of a repeated query key, the default body
 * limit, and the neutral envelope for errors raised outside a route.
 */
export function wireParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: wire parity (FA-077…FA-080)`, () => {
    const reports: HttpErrorReport[] = []
    const onError: HttpErrorReporter = (entry) => {
      reports.push(entry)
    }
    afterEach(() => driver.close())

    const routes = [
      route({
        method: 'GET',
        url: '/echo',
        query: z.object({ q: z.string() }),
        handler: ({ query }) => `hello ${query.q}`,
      }),
      route({
        method: 'GET',
        url: '/page',
        handler: ({ reply }) => reply.header('content-type', 'text/html; charset=utf-8').send('<p>ok</p>'),
      }),
      route({
        method: 'POST',
        url: '/json',
        body: z.object({ a: z.number() }),
        handler: ({ body }) => body,
      }),
      route({ method: 'POST', url: '/any', handler: ({ request }) => ({ body: request.body ?? null }) }),
      route({ method: 'GET', url: '/query', handler: ({ request }) => request.query }),
      route({ method: 'GET', url: '/url', handler: ({ request }) => ({ url: request.url }) }),
      route({
        method: 'GET',
        url: '/events',
        handler: () =>
          sse(async (events) => {
            events.send({ data: { n: 1 } })
          }),
      }),
      route({
        method: 'POST',
        url: '/events',
        handler: () =>
          sse(async (events) => {
            events.send({ data: 'a' })
            await new Promise((resolve) => setTimeout(resolve, 30))
            events.send({ data: 'b' })
          }),
      }),
    ]

    it('serves a string as text/plain; charset=utf-8 — never as HTML (FA-077)', async () => {
      const send = await driver.boot(routes, [])
      const res = await send({ method: 'GET', url: `/echo?q=${encodeURIComponent('<script>alert(1)</script>')}` })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8')
      expect(res.bytes.toString('utf8')).toBe('hello <script>alert(1)</script>')
    })

    it('keeps a Content-Type the handler set itself', async () => {
      const send = await driver.boot(routes, [])
      const res = await send({ method: 'GET', url: '/page' })
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.bytes.toString('utf8')).toBe('<p>ok</p>')
    })

    it('keeps the CORS, security, rate-limit and request-id headers on an event stream (FA-078)', async () => {
      const send = await driver.boot(routes, [
        securityPlugin({ rateLimit: { limit: 10, windowMs: 60_000 }, cors: { origin: true } }),
      ])
      const res = await send({ method: 'GET', url: '/events', headers: { origin: 'https://app.test' } })
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
      expect(res.headers['access-control-allow-origin']).toBe('https://app.test')
      expect(res.headers['x-ratelimit-limit']).toBe('10')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(res.bytes.toString('utf8')).toBe('data: {"n":1}\n\n')
    })

    it('keeps a POST event stream open after its request body was read (FA-080)', async () => {
      const send = await driver.boot(routes, [])
      const res = await send({
        method: 'POST',
        url: '/events',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"since":1}'),
      })
      expect(res.bytes.toString('utf8')).toBe('data: a\n\ndata: b\n\n')
    })

    it('parses JSON only for an application/json or +json media type (FA-079)', async () => {
      const send = await driver.boot(routes, [])
      const body = Buffer.from('{"a":1}')
      const json = (type: string) => send({ method: 'POST', url: '/json', headers: { 'content-type': type }, body })
      expect((await json('application/json')).json).toEqual({ a: 1 })
      expect((await json('Application/JSON; charset=utf-8')).json).toEqual({ a: 1 })
      expect((await json('application/merge-patch+json')).json).toEqual({ a: 1 })
      // CORS-safelisted (no preflight) — must never be treated as JSON.
      for (const type of ['text/plain; application/json', 'text/plain;charset=application/json', 'application/jsonx']) {
        const res = await send({ method: 'POST', url: '/any', headers: { 'content-type': type }, body })
        expect(res.json, type).not.toEqual({ body: { a: 1 } })
        const validated = await json(type)
        expect([400, 415], type).toContain(validated.status)
      }
    })

    it('answers 400 BAD_REQUEST to malformed JSON, never an undefined body (FA-079)', async () => {
      const send = await driver.boot(routes, [], { onError })
      for (const url of ['/json', '/any']) {
        const res = await send({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"a":'),
        })
        expect(res.status, url).toBe(400)
        expect(res.json, url).toEqual({ error: { code: 'BAD_REQUEST', message: 'Malformed request body.' } })
      }
    })

    it('treats an empty JSON body as no body', async () => {
      const send = await driver.boot(routes, [])
      const res = await send({ method: 'POST', url: '/any', headers: { 'content-type': 'application/json' }, body: Buffer.alloc(0) })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ body: null })
    })

    it('hands a repeated query key over as an array (FA-080)', async () => {
      const send = await driver.boot(routes, [])
      const res = await send({ method: 'GET', url: '/query?a=1&a=2&b=3&c[d]=4' })
      expect(res.json).toEqual({ a: ['1', '2'], b: '3', 'c[d]': '4' })
    })

    it('routes case-sensitively and without a trailing-slash alias (FA-080)', async () => {
      const send = await driver.boot(routes, [])
      expect((await send({ method: 'GET', url: '/url' })).status).toBe(200)
      expect((await send({ method: 'GET', url: '/URL' })).status).toBe(404)
      expect((await send({ method: 'GET', url: '/url/' })).status).toBe(404)
    })

    it('reports request.url as path + query string, never an absolute URL', async () => {
      const send = await driver.boot(routes, [])
      expect((await send({ method: 'GET', url: '/url?x=1&y=%20' })).json).toEqual({ url: '/url?x=1&y=%20' })
    })

    it('reports a failing after-hook and leaves the response alone', async () => {
      reports.length = 0
      const failingAfter = definePlugin({
        name: 'test:failing-after',
        boot({ container }) {
          container.get(HTTP_SERVER).after(() => {
            throw new Error('after-hook broke')
          })
        },
      })
      const send = await driver.boot(routes, [failingAfter], { onError })
      const res = await send({ method: 'GET', url: '/url' })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ url: '/url' })
      const deadline = Date.now() + 1_000
      while (reports.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reports.map((entry) => entry.code)).toEqual(['AFTER_HOOK_FAILED'])
    })

    it('accepts a 512 KiB JSON body and refuses a 2 MiB one with 413 by default (FA-080)', async () => {
      const send = await driver.boot(routes, [])
      const of = (bytes: number) => Buffer.from(JSON.stringify({ pad: 'x'.repeat(bytes) }))
      const ok = await send({ method: 'POST', url: '/any', headers: { 'content-type': 'application/json' }, body: of(512 * 1024) })
      expect(ok.status).toBe(200)
      // An adapter may answer 413 and close the socket while the client is
      // still writing the body; under load the client then fails with EPIPE /
      // ECONNRESET before it reads the answer. Either way the body was refused.
      const big = await send({ method: 'POST', url: '/any', headers: { 'content-type': 'application/json' }, body: of(2 * 1024 * 1024) }).catch(
        (error: unknown) => {
          const code = (error as { cause?: { code?: string } }).cause?.code
          if (code === 'EPIPE' || code === 'ECONNRESET') return null
          throw error
        },
      )
      if (big) {
        expect(big.status).toBe(413)
        expect((big.json as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE')
      }
    })

    const failing = (thrown: () => unknown) =>
      definePlugin({
        name: 'test:failing-edge',
        boot({ container }) {
          const server = container.get(HTTP_SERVER)
          server.use(({ request }) => {
            if (request.url.startsWith('/explode')) throw thrown()
          })
          server.addRoute('GET', '/extra', () => {
            throw thrown()
          })
        },
      })

    it('answers a failing pre-hook or edge route with the neutral JSON 500, and reports it (FA-078)', async () => {
      reports.length = 0
      const send = await driver.boot(routes, [failing(() => new Error('boom at /srv/app.ts'))], { onError })
      for (const url of ['/explode', '/extra']) {
        const res = await send({ method: 'GET', url })
        expect(res.status, url).toBe(500)
        expect(res.json, url).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } })
      }
      expect(reports.map((entry) => entry.status)).toEqual([500, 500])
    })

    it('keeps a 500 for an SDK error that merely carries a status and a type (FA-080)', async () => {
      // Shaped like a payment SDK's error: `type` and `statusCode`, no `expose`.
      const sdk = () => Object.assign(new Error('Invalid API key'), { type: 'invalid_request_error', status: 401, statusCode: 401 })
      const send = await driver.boot(routes, [failing(sdk)], { onError })
      const res = await send({ method: 'GET', url: '/explode' })
      expect(res.status).toBe(500)
      expect((res.json as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR')
    })

    it('keeps the in-flight gauge at zero after short-circuited and finished requests (FA-080)', async () => {
      const registry = new MetricsRegistry()
      const send = await driver.boot(routes, [
        securityPlugin({ rateLimit: { limit: 1, windowMs: 60_000 }, headers: false }),
        metricsPlugin({ registry }),
      ])
      expect((await send({ method: 'GET', url: '/echo?q=1' })).status).toBe(200)
      expect((await send({ method: 'GET', url: '/echo?q=1' })).status).toBe(429)
      expect((await send({ method: 'GET', url: '/echo?q=1' })).status).toBe(429)
      expect(await eventually(() => inFlightOf(registry), 0)).toBe(0)
    })

    it('releases the in-flight gauge when the client disconnects mid-stream (FA-080)', async () => {
      const registry = new MetricsRegistry()
      const hanging = route({
        method: 'GET',
        url: '/hang',
        handler: () => sse((events) => new Promise<void>((resolve) => events.onClose(resolve))),
      })
      const send = await driver.boot([hanging], [metricsPlugin({ registry })])
      const abort = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/hang', signal: abort.signal })
      expect(res.status).toBe(200)
      abort.abort()
      await res.body?.cancel().catch(() => {})
      expect(await eventually(() => inFlightOf(registry), 0)).toBe(0)
    })
  })
}

/**
 * Route-table parity (BK-025): every adapter publishes the same `http:routes`
 * entries at boot, so `describeRoutes()` — what `basalt routes` prints and
 * route-security tests assert on — is identical on all three. Edge routes
 * added through `HTTP_SERVER.addRoute()` (health, metrics, openapi) are NOT
 * in the bucket on any adapter; this pins that too, since the docs say so.
 */
export function routeTableParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: route table parity (BK-025)`, () => {
    afterEach(() => driver.close())

    it('describeRoutes() over the booted bucket is the same on every adapter', async () => {
      let bucket: RouteTableEntry[] = []
      const guards = definePlugin({
        name: 'test:route-table-guards',
        register({ container }) {
          const metadata = ensureMetadata(container)
          metadata.add(GUARDED_META_BUCKET, 'auth')
          metadata.add(GUARDED_META_BUCKET, 'can')
        },
        boot({ container, hooks }) {
          container.get(HTTP_SERVER).addRoute('GET', '/livez', () => ({ ok: true }))
          hooks.on('app:booted', () => {
            bucket = ensureMetadata(container).get<RouteTableEntry>('http:routes')
          })
        },
      })
      const handler = () => ({ ok: true })
      const send = await driver.boot(
        [
          route({ method: 'GET', url: '/projects', meta: { auth: true, can: 'projects:read' }, handler }),
          route({
            method: 'POST',
            url: '/projects',
            meta: { auth: true, can: ['projects:create'], rateLimit: { limit: 5, windowMs: 60_000, key: 'user' }, tenant: true },
            handler,
          }),
          route({ method: 'GET', url: '/pricing', meta: { auth: false, tenant: false }, handler }),
          route({ method: 'GET', url: '/open', handler }),
          route({ method: 'GET', url: '/console', meta: { auth: true, can: false, tenant: 'never' }, handler }),
        ],
        [guards],
      )
      expect((await send({ method: 'GET', url: '/livez' })).status).toBe(200)
      const rows = describeRoutes(bucket)
      expect(rows).toEqual([
        { method: 'GET', url: '/console', auth: true, can: [], rateLimit: null, tenant: 'central-only', public: false, guards: [] },
        { method: 'GET', url: '/open', auth: null, can: null, rateLimit: null, tenant: null, public: false, guards: [] },
        { method: 'GET', url: '/pricing', auth: false, can: null, rateLimit: null, tenant: 'exempt', public: true, guards: [] },
        { method: 'GET', url: '/projects', auth: true, can: ['projects:read'], rateLimit: null, tenant: null, public: false, guards: [] },
        {
          method: 'POST',
          url: '/projects',
          auth: true,
          can: ['projects:create'],
          rateLimit: '5/1m per user',
          tenant: 'required',
          public: false,
          guards: [],
        },
      ])
      expect(findUnguardedRoutes(rows, { require: ['auth', 'can'] }).map(({ row }) => row.url)).toEqual(['/open'])
    })
  })
}

/**
 * Request disposers (BK-077): an enricher may return cleanup for the end of
 * its request (prismaPlugin returns a leased tenant client). Every adapter
 * must run it exactly once — after a buffered reply, an error, a fully read
 * stream, an event stream the client closed, a download the client abandoned,
 * and when a later enricher rejects the request — and never while the body is
 * still being sent.
 */
export function disposerParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: request disposer parity (BK-077)`, () => {
    const disposed: string[] = []
    const sources: { big?: CountingSource } = {}
    let streamDone = false

    const disposing = definePlugin({
      name: 'test:disposing',
      register({ container }) {
        const take: RequestEnricher = ({ request }) => {
          const path = request.url.split('?')[0]
          const label = `${request.method} ${path}`
          return () => {
            // A stream's disposer must not run before its body was sent.
            if (path === '/stream') disposed.push(streamDone ? label : `${label} (early)`)
            else disposed.push(label)
          }
        }
        const reject: RequestEnricher = ({ request }) => {
          if (request.headers['x-reject'] === '1') throw new HttpError(403, 'REJECTED', 'No.')
        }
        ensureMetadata(container).add('http:enrichers', take)
        ensureMetadata(container).add('http:enrichers', reject)
      },
    })

    const routes = [
      route({ method: 'GET', url: '/plain', handler: () => ({ ok: true }) }),
      route({
        method: 'GET',
        url: '/fail',
        handler: () => {
          throw new Error('handler failed')
        },
      }),
      route({
        method: 'GET',
        url: '/stream',
        handler: () => {
          const source = Readable.from(
            (async function* () {
              yield Buffer.from('a')
              yield Buffer.from('b')
              streamDone = true
            })(),
          )
          return stream(source, { contentType: 'text/plain' })
        },
      }),
      route({
        method: 'GET',
        url: '/big',
        handler() {
          const source = new CountingSource(BIG_BYTES)
          sources.big = source
          return stream(source, { contentType: 'application/octet-stream' })
        },
      }),
      route({
        method: 'GET',
        url: '/events',
        handler: () => sse((events) => new Promise<void>((resolve) => events.onClose(resolve))),
      }),
    ]

    let send: Send
    const boot = async () => {
      disposed.length = 0
      streamDone = false
      delete sources.big
      send = await driver.boot(routes, [disposing])
    }
    afterEach(() => driver.close())

    const settled = async (): Promise<string[]> => {
      await until(() => disposed.length > 0, 'the disposer to run')
      await settle(30)
      return disposed
    }

    it('runs once after a buffered reply', async () => {
      await boot()
      expect((await send({ method: 'GET', url: '/plain' })).status).toBe(200)
      expect(await settled()).toEqual(['GET /plain'])
    })

    it('runs once after a handler error', async () => {
      await boot()
      expect((await send({ method: 'GET', url: '/fail' })).status).toBe(500)
      expect(await settled()).toEqual(['GET /fail'])
    })

    it('runs once when a later enricher rejects the request', async () => {
      await boot()
      expect((await send({ method: 'GET', url: '/plain', headers: { 'x-reject': '1' } })).status).toBe(403)
      expect(await settled()).toEqual(['GET /plain'])
    })

    it('runs once, after the last byte, for a streamed body', async () => {
      await boot()
      const res = await send({ method: 'GET', url: '/stream' })
      expect(res.bytes.toString()).toBe('ab')
      expect(await settled()).toEqual(['GET /stream'])
    })

    it('runs once when the client abandons a download — not before', async () => {
      await boot()
      const controller = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/big', signal: controller.signal })
      const reader = res.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      expect(disposed).toEqual([])
      controller.abort()
      expect(await settled()).toEqual(['GET /big'])
    })

    it('runs once, only when the client closes an event stream', async () => {
      await boot()
      const controller = new AbortController()
      const res = await send.raw({ method: 'GET', url: '/events', signal: controller.signal })
      expect(res.status).toBe(200)
      await settle(50)
      expect(disposed).toEqual([])
      controller.abort()
      await res.body?.cancel().catch(() => {})
      expect(await settled()).toEqual(['GET /events'])
    })
  })
}

/**
 * A second, separately instantiated copy of this package's `rawBody()` and
 * `upload()` — what a feature package with its own nested `@basaltkit/http`
 * hands the adapter (BK-038). The query string makes the module loader treat
 * the same file as a distinct module, so its module-level state is not shared
 * with the copy the adapter imported.
 */
async function secondCopy(): Promise<{ rawBody: typeof rawBody; upload: typeof upload }> {
  const rawModule = (await import(/* @vite-ignore */ new URL('../dist/raw-body.js?copy=2', import.meta.url).href)) as {
    rawBody: typeof rawBody
  }
  const uploadModule = (await import(/* @vite-ignore */ new URL('../dist/upload.js?copy=2', import.meta.url).href)) as {
    upload: typeof upload
  }
  return { rawBody: rawModule.rawBody, upload: uploadModule.upload }
}

export function crossCopyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: rawBody()/upload() from another copy of @basaltkit/http (BK-038)`, () => {
    afterEach(() => driver.close())

    it('is a genuinely separate module instance', async () => {
      const copy = await secondCopy()
      expect(copy.rawBody).not.toBe(rawBody)
      expect(copy.upload).not.toBe(upload)
    })

    it('delivers the exact bytes to a rawBody() route built by the other copy', async () => {
      const copy = await secondCopy()
      const send = await driver.boot(
        [
          route({
            method: 'POST',
            url: '/hook',
            body: copy.rawBody({ maxBytes: 1024 }),
            handler: ({ body }) => ({ hex: body.bytes.toString('hex') }),
          }),
        ],
        [],
      )
      const payload = Buffer.from('{"b": 1,  "a":2}', 'utf8')
      const res = await send({ method: 'POST', url: '/hook', body: payload, headers: { 'content-type': 'application/json' } })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ hex: payload.toString('hex') })
    })

    it('streams files to an upload() route built by the other copy', async () => {
      const copy = await secondCopy()
      const send = await driver.boot(
        [
          route({
            method: 'POST',
            url: '/files',
            body: copy.upload({ maxBytes: 64 * 1024, maxFiles: 2 }),
            async handler({ body }) {
              const files: { name: string; size: number }[] = []
              for await (const file of body.files) {
                let size = 0
                for await (const chunk of file.stream) size += (chunk as Buffer).length
                files.push({ name: file.filename, size })
              }
              return { files, fields: { ...body.fields } }
            },
          }),
        ],
        [],
      )
      const res = await send({
        method: 'POST',
        url: '/files',
        body: multipart([
          { name: 'title', value: 'Contract' },
          { name: 'doc', filename: 'contract.pdf', type: 'application/pdf', data: '%PDF-1.7 body' },
        ]),
        headers: { 'content-type': contentType() },
      })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ files: [{ name: 'contract.pdf', size: 13 }], fields: { title: 'Contract' } })
    })
  })
}

/**
 * Idempotency on every adapter (BK-084e): the stage lives in the shared route
 * pipeline, so a key replays, conflicts and refuses a reused body identically
 * on Fastify, Express and Hono.
 */
export function idempotencyParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: idempotency parity (BK-084e)`, () => {
    afterEach(() => driver.close())
    let runs = 0
    const revoked = new Set<string>()
    /** Stands in for auth: `authorization: Bearer <x>` signs in unless revoked. */
    const auth = definePlugin({
      name: 'test:auth',
      register({ container }) {
        const guard: RouteGuard = ({ route: r, request }) => {
          if (r.meta?.['signedIn'] !== true) return
          const token = request.headers['authorization']
          if (typeof token !== 'string' || revoked.has(token)) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in.')
        }
        ensureMetadata(container).add('http:guards', guard)
      },
    })
    const gate: { release: (() => void) | undefined } = { release: undefined }
    const routes = [
      route({
        method: 'POST',
        url: '/charge',
        body: z.object({ amount: z.number(), note: z.string().optional() }),
        meta: { signedIn: true },
        // The documented shape: a handler that RETURNS its payload (FA-001).
        handler: ({ body, reply }) => {
          runs += 1
          reply.code(201)
          return { charge: runs, amount: body.amount }
        },
      }),
      route({
        method: 'POST',
        url: '/slow',
        body: z.object({ amount: z.number() }),
        async handler({ body }) {
          runs += 1
          await new Promise<void>((resolve) => (gate.release = resolve))
          return { charge: runs, amount: body.amount }
        },
      }),
      route({
        method: 'POST',
        url: '/flaky',
        handler: () => {
          runs += 1
          if (runs === 1) throw new Error('transient')
          return { charge: runs }
        },
      }),
      route({
        method: 'POST',
        url: '/download',
        handler: () => {
          runs += 1
          return stream(Readable.from([Buffer.from(`run ${runs}`)]), { contentType: 'text/plain' })
        },
      }),
      route({
        method: 'POST',
        url: '/hook',
        body: rawBody({ maxBytes: 1024 }),
        handler: ({ body }) => {
          runs += 1
          return { charge: runs, length: body.bytes.length }
        },
      }),
    ]
    const json = (value: unknown) => Buffer.from(JSON.stringify(value))
    const headers = (key: string, extra: Record<string, string> = {}) => ({
      authorization: 'Bearer user-1',
      'content-type': 'application/json',
      'idempotency-key': key,
      ...extra,
    })
    const codeOf = (res: ParityResponse) => (res.json as { error?: { code?: string } } | undefined)?.error?.code
    const boot = (options: Parameters<typeof idempotencyPlugin>[0] = {}) => {
      runs = 0
      revoked.clear()
      return driver.boot(routes, [idempotencyPlugin(options), auth])
    }

    it('replays the first response for a repeated key and runs the handler once', async () => {
      const send = await boot()
      const first = await send({ method: 'POST', url: '/charge', headers: headers('k1'), body: json({ amount: 10 }) })
      const second = await send({ method: 'POST', url: '/charge', headers: headers('k1'), body: json({ amount: 10 }) })
      expect(first.status).toBe(201)
      expect(first.headers['idempotent-replayed']).toBeUndefined()
      expect(second.status).toBe(201)
      expect(second.json).toEqual(first.json)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.headers['content-type']).toMatch(/^application\/json/)
      expect(runs).toBe(1)
    })

    it('without fingerprinting, a different body under the same key replays the first result (current default)', async () => {
      const send = await boot()
      await send({ method: 'POST', url: '/charge', headers: headers('k2'), body: json({ amount: 10 }) })
      const reused = await send({ method: 'POST', url: '/charge', headers: headers('k2'), body: json({ amount: 99 }) })
      expect(reused.status).toBe(201)
      expect(reused.json).toEqual({ charge: 1, amount: 10 })
    })

    it("fingerprint: 'body' refuses a different body under the same key with 422, and replays a reordered same body", async () => {
      const send = await boot({ fingerprint: 'body' })
      await send({ method: 'POST', url: '/charge', headers: headers('k3'), body: json({ amount: 10, note: 'a' }) })
      const reordered = await send({ method: 'POST', url: '/charge', headers: headers('k3'), body: Buffer.from('{"note":"a","amount":10}') })
      expect(reordered.status).toBe(201)
      expect(reordered.headers['idempotent-replayed']).toBe('true')
      const reused = await send({ method: 'POST', url: '/charge', headers: headers('k3'), body: json({ amount: 99, note: 'a' }) })
      expect(reused.status).toBe(422)
      expect(codeOf(reused)).toBe('IDEMPOTENCY_KEY_REUSED')
      expect(runs).toBe(1)
    })

    it('a concurrent repeat gets 409 with the same body and 422 with a different one', async () => {
      const send = await boot({ fingerprint: 'body' })
      gate.release = undefined
      const first = send({ method: 'POST', url: '/slow', headers: headers('k4'), body: json({ amount: 10 }) })
      while (!gate.release) await new Promise((resolve) => setTimeout(resolve, 5))
      const same = await send({ method: 'POST', url: '/slow', headers: headers('k4'), body: json({ amount: 10 }) })
      const different = await send({ method: 'POST', url: '/slow', headers: headers('k4'), body: json({ amount: 11 }) })
      ;(gate.release as unknown as () => void)()
      expect((await first).status).toBe(200)
      expect(same.status).toBe(409)
      expect(codeOf(same)).toBe('IDEMPOTENCY_CONFLICT')
      expect(different.status).toBe(422)
      expect(codeOf(different)).toBe('IDEMPOTENCY_KEY_REUSED')
      expect(runs).toBe(1)
    })

    it('by default a replay runs before the guards; replayAfterGuards answers a revoked caller 401', async () => {
      let send = await boot()
      await send({ method: 'POST', url: '/charge', headers: headers('k5'), body: json({ amount: 10 }) })
      revoked.add('Bearer user-1')
      const legacy = await send({ method: 'POST', url: '/charge', headers: headers('k5'), body: json({ amount: 10 }) })
      expect(legacy.status).toBe(201) // the cached success, despite the revoked token
      await driver.close()

      send = await boot({ replayAfterGuards: true })
      await send({ method: 'POST', url: '/charge', headers: headers('k6'), body: json({ amount: 10 }) })
      revoked.add('Bearer user-1')
      const guarded = await send({ method: 'POST', url: '/charge', headers: headers('k6'), body: json({ amount: 10 }) })
      expect(guarded.status).toBe(401)
      expect(guarded.headers['idempotent-replayed']).toBeUndefined()
      expect(runs).toBe(1)
    })

    it('does not cache a 5xx: the retry runs the handler again', async () => {
      const send = await boot()
      const first = await send({ method: 'POST', url: '/flaky', headers: headers('k7') })
      const second = await send({ method: 'POST', url: '/flaky', headers: headers('k7') })
      expect(first.status).toBe(500)
      expect(second.status).toBe(200)
      expect(second.json).toEqual({ charge: 2 })
      expect(second.headers['idempotent-replayed']).toBeUndefined()
    })

    it('a streamed response is not cached', async () => {
      const send = await boot()
      const first = await send({ method: 'POST', url: '/download', headers: headers('k8') })
      const second = await send({ method: 'POST', url: '/download', headers: headers('k8') })
      expect(first.bytes.toString()).toBe('run 1')
      expect(second.bytes.toString()).toBe('run 2')
      expect(second.headers['idempotent-replayed']).toBeUndefined()
    })

    it('fingerprints a rawBody() route on its exact bytes', async () => {
      const send = await boot({ fingerprint: 'body' })
      const bytes = Buffer.from('{"b":1, "a":2}')
      const first = await send({ method: 'POST', url: '/hook', headers: headers('k9'), body: bytes })
      const again = await send({ method: 'POST', url: '/hook', headers: headers('k9'), body: bytes })
      // Same JSON, different bytes: a signed raw body is a different request.
      const other = await send({ method: 'POST', url: '/hook', headers: headers('k9'), body: Buffer.from('{"a":2,"b":1}') })
      expect(first.status).toBe(200)
      expect(again.headers['idempotent-replayed']).toBe('true')
      expect(other.status).toBe(422)
      expect(runs).toBe(1)
    })

    it('rejects an over-long key and ignores anonymous callers by default', async () => {
      const send = await boot()
      const long = await send({ method: 'POST', url: '/flaky', headers: headers('x'.repeat(256)) })
      expect(long.status).toBe(400)
      expect(codeOf(long)).toBe('IDEMPOTENCY_KEY_INVALID')
      runs = 1 // past the flaky first failure
      const anon = { 'idempotency-key': 'k10' }
      const a = await send({ method: 'POST', url: '/flaky', headers: anon })
      const b = await send({ method: 'POST', url: '/flaky', headers: anon })
      expect([a.json, b.json]).toEqual([{ charge: 2 }, { charge: 3 }])
    })
  })
}

/**
 * Route-scoped static headers (BK-085): `meta.headers` is set as soon as the
 * route matches, so it is on every response the route produces — success and
 * the errors raised by guards, validation or the handler — on every adapter.
 */
export function routeHeadersParitySuite(adapter: string, driver: ParityDriver): void {
  describe(`${adapter}: route meta.headers parity (BK-085)`, () => {
    afterEach(() => driver.close())
    const shareHeaders = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }
    const routes = [
      route({
        method: 'POST',
        url: '/share/:id',
        params: z.object({ id: z.string() }),
        body: z.object({ password: z.string() }),
        meta: { signedIn: true, headers: shareHeaders },
        handler: ({ params }) => ({ id: params.id }),
      }),
      route({
        method: 'GET',
        url: '/share/boom',
        meta: { headers: shareHeaders },
        handler: () => {
          throw new Error('kaboom')
        },
      }),
      route({
        method: 'GET',
        url: '/share/override',
        meta: { headers: shareHeaders },
        handler: ({ reply }) => {
          reply.header('Cache-Control', 'private, max-age=60')
          return { ok: true }
        },
      }),
      route({ method: 'GET', url: '/plain', handler: () => ({ ok: true }) }),
    ]
    const boot = () => driver.boot(routes, [identity([]), securityPlugin({ headers: true })])
    const json = (value: unknown) => Buffer.from(JSON.stringify(value))
    const expectShareHeaders = (res: ParityResponse) => {
      expect(res.headers['x-robots-tag']).toBe('noindex')
      expect(res.headers['cache-control']).toBe('no-store')
    }

    it('are on a 200, and override a global security header', async () => {
      const send = await boot()
      const res = await send({
        method: 'POST',
        url: '/share/s1',
        headers: { 'x-user': 'u1', 'content-type': 'application/json' },
        body: json({ password: 'p' }),
      })
      expect(res.status).toBe(200)
      expectShareHeaders(res) // Cache-Control: no-store wins over the securityPlugin default
    })

    it("are on a guard's 401, a validation 400 and a thrown 500", async () => {
      const send = await boot()
      const unauthorized = await send({ method: 'POST', url: '/share/s1', headers: { 'content-type': 'application/json' }, body: json({ password: 'p' }) })
      expect(unauthorized.status).toBe(401)
      expectShareHeaders(unauthorized)
      const invalid = await send({ method: 'POST', url: '/share/s1', headers: { 'x-user': 'u1', 'content-type': 'application/json' }, body: json({}) })
      expect(invalid.status).toBe(400)
      expectShareHeaders(invalid)
      const thrown = await send({ method: 'GET', url: '/share/boom' })
      expect(thrown.status).toBe(500)
      expectShareHeaders(thrown)
    })

    it('a handler can still override one, and other routes are untouched', async () => {
      const send = await boot()
      const overridden = await send({ method: 'GET', url: '/share/override' })
      expect(overridden.headers['cache-control']).toBe('private, max-age=60')
      expect(overridden.headers['x-robots-tag']).toBe('noindex')
      const plain = await send({ method: 'GET', url: '/plain' })
      expect(plain.headers['x-robots-tag']).toBeUndefined()
    })

    it('an invalid meta.headers refuses the boot', async () => {
      const bad = [
        route({ method: 'GET', url: '/crlf', meta: { headers: { 'X-Note': 'a\r\nSet-Cookie: x=1' } }, handler: () => 'x' }),
        route({ method: 'GET', url: '/cookie', meta: { headers: { 'Set-Cookie': 'a=1' } }, handler: () => 'x' }),
        route({ method: 'GET', url: '/number', meta: { headers: { 'X-Count': 1 } }, handler: () => 'x' }),
      ]
      const booting = driver.boot(bad, [])
      await expect(booting).rejects.toBeInstanceOf(InvalidRouteMetaError)
      await booting.catch((error: InvalidRouteMetaError) => {
        expect(error.problems.map((p) => p.route)).toEqual(['GET /crlf', 'GET /cookie', 'GET /number'])
      })
    })
  })
}
