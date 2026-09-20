import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RAW_BODY_MAX_BYTES,
  isRawBody,
  isUploadBody,
  rawBody,
  rawBodyOptionsOf,
  rawBodyRouteMatcher,
  route,
  runRoute,
  generateOpenApi,
  upload,
  type BasaltRoute,
  type HttpReply,
  type HttpRequest,
} from '../src/index.js'
import { z } from 'zod'
import { Container } from '@basaltkit/core'

class Recorder implements HttpReply {
  status = 200
  payload: unknown
  headers: Record<string, string> = {}
  private _sent = false
  get sent(): boolean {
    return this._sent
  }
  get statusCode(): number {
    return this.status
  }
  get raw(): unknown {
    return this
  }
  code(status: number): this {
    this.status = status
    return this
  }
  header(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value
    return this
  }
  send(payload?: unknown): this {
    this._sent = true
    this.payload = payload
    return this
  }
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'POST',
    url: '/hook',
    headers: {},
    params: {},
    query: {},
    body: undefined,
    raw: {},
    ...overrides,
  }
}

const call = (definition: BasaltRoute, input: HttpRequest, reply = new Recorder()) =>
  runRoute(definition, input, reply, { container: new Container() }).then((result) => ({ result, reply }))

const echo = (options?: Parameters<typeof rawBody>[0]) =>
  route({
    method: 'POST',
    url: '/hook',
    body: rawBody(options),
    handler: ({ body }) => ({
      hex: body.bytes.toString('hex'),
      text: body.text(),
      contentType: body.contentType ?? null,
      contentLength: body.contentLength ?? null,
    }),
  })

describe('the rawBody() marker', () => {
  it('is recognised as a raw body and never as an upload', () => {
    const schema = rawBody()
    expect(isRawBody(schema)).toBe(true)
    expect(isUploadBody(schema)).toBe(false)
    expect(isRawBody(upload({ maxBytes: 10, maxFiles: 1 }))).toBe(false)
    expect(isRawBody(z.object({}))).toBe(false)
    expect(isRawBody(undefined)).toBe(false)
  })

  it('defaults to a small cap and carries the one it was given', () => {
    expect(rawBodyOptionsOf(rawBody())).toEqual({ maxBytes: DEFAULT_RAW_BODY_MAX_BYTES })
    expect(rawBodyOptionsOf(rawBody({ maxBytes: 64 }))).toEqual({ maxBytes: 64 })
    expect(rawBodyOptionsOf(z.string())).toBeUndefined()
  })

  it('refuses a nonsensical cap at declaration time, not at request time', () => {
    expect(() => rawBody({ maxBytes: 0 })).toThrow(TypeError)
    expect(() => rawBody({ maxBytes: -1 })).toThrow(TypeError)
    expect(() => rawBody({ maxBytes: 1.5 })).toThrow(TypeError)
  })
})

describe('reading the bytes', () => {
  it('reads a Node stream exactly, and reports the declared framing', async () => {
    const payload = Buffer.from('{  "b" : 2,\n "a":1 }', 'utf8')
    const { result } = await call(
      echo(),
      request({
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) },
        bodyStream: Readable.from([payload.subarray(0, 5), payload.subarray(5)]),
      }),
    )
    expect(result).toEqual({
      hex: payload.toString('hex'),
      text: payload.toString('utf8'),
      contentType: 'application/json',
      contentLength: payload.length,
    })
  })

  it('reads a web ReadableStream exactly', async () => {
    const payload = Buffer.from([0x00, 0xff, 0x7b])
    const { result } = await call(
      echo(),
      request({
        headers: { 'content-type': 'application/octet-stream' },
        bodyStream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(payload))
            controller.close()
          },
        }),
      }),
    )
    expect((result as { hex: string }).hex).toBe(payload.toString('hex'))
  })

  it('prefers bytes an adapter had to keep over a stream it cannot offer', async () => {
    const payload = Buffer.from('kept')
    const { result } = await call(echo(), request({ bodyBytes: payload, body: { parsed: true } }))
    expect((result as { text: string }).text).toBe('kept')
  })

  it('treats a bodiless request as empty rather than missing', async () => {
    const { result } = await call(echo(), request({ bodyStream: Readable.from([]) }))
    expect(result).toEqual({ hex: '', text: '', contentType: null, contentLength: null })
  })

  it('never falls back to the parsed body — it fails closed instead', async () => {
    // The bug this whole marker exists to make impossible: a parsed object is
    // present, and it is NOT a source of bytes. The request declared bytes, so
    // their absence is a real failure.
    await expect(
      call(echo(), request({ headers: { 'content-length': '14' }, body: { id: 'evt_1' } })),
    ).rejects.toMatchObject({ status: 500, code: 'RAW_BODY_UNAVAILABLE' })
  })

  it('fails closed for a chunked body that no adapter could hand over', async () => {
    await expect(
      call(echo(), request({ headers: { 'transfer-encoding': 'chunked' }, body: { id: 'evt_1' } })),
    ).rejects.toMatchObject({ status: 500, code: 'RAW_BODY_UNAVAILABLE' })
  })

  it('treats a request that declared no body as empty, not as unavailable', async () => {
    // A POST with no body at all is the shape several providers validate a
    // webhook URL with (Microsoft Graph posts `?validationToken=` before the
    // subscription exists). There is no message to misverify here — the empty
    // body IS the message — so refusing it would report a body-parser problem
    // as a subscription failure.
    const { result } = await call(echo(), request({ method: 'POST' }))
    expect(result).toEqual({ hex: '', text: '', contentType: null, contentLength: null })
  })

  it('treats an explicitly zero-length body as empty too', async () => {
    const { result } = await call(
      echo(),
      request({ method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '0' } }),
    )
    expect(result).toMatchObject({ hex: '', contentType: 'text/plain', contentLength: 0 })
  })
})

describe('the size cap', () => {
  it('refuses a declared Content-Length over the cap without reading anything', async () => {
    let read = false
    const stream = new Readable({
      read() {
        read = true
        this.push(null)
      },
    })
    await expect(
      call(
        echo({ maxBytes: 8 }),
        request({ headers: { 'content-length': '999' }, bodyStream: stream }),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
    expect(read).toBe(false)
  })

  it('refuses on the bytes actually received when nothing was declared', async () => {
    await expect(
      call(
        echo({ maxBytes: 8 }),
        request({ bodyStream: Readable.from([Buffer.alloc(5), Buffer.alloc(5)]) }),
      ),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
  })

  it('refuses kept bytes over the cap too', async () => {
    await expect(call(echo({ maxBytes: 8 }), request({ bodyBytes: Buffer.alloc(9) }))).rejects.toMatchObject({
      status: 413,
    })
  })

  it('turns a body that ends mid-flight into a 400, not a 500', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('socket hang up'))
      },
    })
    await expect(call(echo(), request({ bodyStream: stream }))).rejects.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    })
  })
})

describe('a body the route never got to read', () => {
  it('is drained and the connection closed when a guard rejects first', async () => {
    let drained = false
    const stream = Readable.from([Buffer.from('payload')])
    stream.once('end', () => (drained = true))
    const reply = new Recorder()
    const guard = () => {
      throw new Error('nope')
    }
    await expect(
      runRoute(echo(), request({ bodyStream: stream }), reply, {
        container: new Container(),
        guards: [guard],
      }),
    ).rejects.toThrow('nope')
    expect(reply.headers['connection']).toBe('close')
    await new Promise((resolve) => setImmediate(resolve))
    expect(drained).toBe(true)
  })

  it('leaves a body the handler DID read alone', async () => {
    const reply = new Recorder()
    await call(echo(), request({ bodyStream: Readable.from([Buffer.from('x')]) }), reply)
    expect(reply.headers['connection']).toBeUndefined()
  })
})

describe('rawBodyRouteMatcher', () => {
  const routes = [
    route({ method: 'POST', url: '/drives/:provider/notifications', body: rawBody(), handler: () => null }),
    route({ method: 'POST', url: '/billing/webhook', body: rawBody(), handler: () => null }),
    route({ method: 'POST', url: '/billing/checkout', body: z.object({}), handler: () => null }),
    route({ method: 'GET', url: '/drives/:provider/notifications', handler: () => null }),
  ]
  const matches = rawBodyRouteMatcher(routes)

  it('matches a literal path and a path parameter, on the declared method only', () => {
    expect(matches('POST', '/billing/webhook')).toBe(true)
    expect(matches('post', '/billing/webhook?x=1')).toBe(true)
    expect(matches('POST', '/drives/dropbox/notifications')).toBe(true)
    expect(matches('GET', '/drives/dropbox/notifications')).toBe(false)
  })

  it('does not match a neighbouring JSON route, a prefix or an extra segment', () => {
    expect(matches('POST', '/billing/checkout')).toBe(false)
    expect(matches('POST', '/billing')).toBe(false)
    expect(matches('POST', '/billing/webhook/extra')).toBe(false)
    expect(matches('POST', '/drives/dropbox/a/notifications')).toBe(false)
  })

  it('is a constant false when nothing declares a raw body', () => {
    const none = rawBodyRouteMatcher([route({ method: 'POST', url: '/a', handler: () => null })])
    expect(none('POST', '/a')).toBe(false)
  })

  it('reads a trailing wildcard as "the rest of the path"', () => {
    const wild = rawBodyRouteMatcher([
      route({ method: 'POST', url: '/hooks/*', body: rawBody(), handler: () => null }),
    ])
    expect(wild('POST', '/hooks/stripe')).toBe(true)
    expect(wild('POST', '/hooks/a/b')).toBe(true)
    expect(wild('POST', '/other')).toBe(false)
  })
})

describe('OpenAPI', () => {
  it('publishes a raw body as opaque bytes, with no invented schema', () => {
    const document = generateOpenApi(
      [{ method: 'POST', url: '/hook', body: rawBody() }],
      { title: 'API', version: '1.0.0' },
    )
    const operation = (document.paths as Record<string, Record<string, { requestBody?: unknown }>>)['/hook']!['post']!
    expect(operation.requestBody).toEqual({
      required: true,
      content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
    })
  })
})
