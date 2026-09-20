/**
 * Shared adapter parity matrix for `upload()` bodies (BK-006), keyed per-route
 * rate limits (BK-008), structured error details (BK-021), streaming
 * responses (BK-019) and `rawBody()` bodies (BK-029). Not a test file on its own: each adapter package
 * (fastify, express, hono) runs it against its own driver, so the three are
 * held to the exact same assertions.
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { ctx, definePlugin, ensureMetadata, type BasaltPlugin } from '@basaltkit/core'
import {
  HttpError,
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

