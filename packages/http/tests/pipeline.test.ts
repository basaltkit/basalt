import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Container, tryCtx } from '@basaltkit/core'
import { HttpError, route, runRoute, toErrorResponse, type HttpReply, type HttpRequest } from '../src/index.js'

class CaptureReply implements HttpReply {
  private _status = 200
  private _sent = false
  payload: unknown
  headers = new Map<string, string>()
  get sent(): boolean {
    return this._sent
  }
  get statusCode(): number {
    return this._status
  }
  raw = null
  code(status: number): this {
    this._status = status
    return this
  }
  header(name: string, value: string): this {
    this.headers.set(name, value)
    return this
  }
  send(payload: unknown): this {
    this._sent = true
    this.payload = payload
    return this
  }
}

const makeRequest = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET',
  url: '/',
  headers: {},
  params: {},
  query: {},
  body: undefined,
  raw: null,
  ...over,
})

describe('runRoute', () => {
  it('validates, runs enrichers then guards, and invokes the handler in context', async () => {
    const order: string[] = []
    const container = new Container()
    const def = route({
      method: 'POST',
      url: '/things/:id',
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string().min(2) }),
      async handler({ body, params }) {
        order.push('handler')
        return { id: params.id, name: body.name, reqId: tryCtx()?.requestId }
      },
    })

    const reply = new CaptureReply()
    const result = await runRoute(def, makeRequest({ method: 'POST', params: { id: 'p1' }, body: { name: 'ok' } }), reply, {
      container,
      enrichers: [async () => void order.push('enrich')],
      guards: [async () => void order.push('guard')],
    })

    expect(order).toEqual(['enrich', 'guard', 'handler'])
    expect((result as { id: string }).id).toBe('p1')
    expect((result as { reqId?: string }).reqId).toBeTruthy()
    expect(reply.headers.get('x-request-id')).toBeTruthy()
  })

  it('adopts an inbound x-correlation-id (array header) as the correlation id', async () => {
    const def = route({
      method: 'GET',
      url: '/x',
      async handler() {
        return { cid: tryCtx()?.correlationId }
      },
    })
    const reply = new CaptureReply()
    const result = await runRoute(def, makeRequest({ headers: { 'x-correlation-id': ['corr-123'] } }), reply, {
      container: new Container(),
    })
    expect((result as { cid?: string }).cid).toBe('corr-123')
  })

  it('throws RequestValidationError on bad input (→ 400 via toErrorResponse)', async () => {
    const def = route({
      method: 'POST',
      url: '/x',
      body: z.object({ name: z.string().min(2) }),
      async handler() {
        return 'never'
      },
    })
    await expect(
      runRoute(def, makeRequest({ method: 'POST', body: { name: 'a' } }), new CaptureReply(), { container: new Container() }),
    ).rejects.toMatchObject({ code: 'HTTP_VALIDATION', part: 'body' })
  })

  it('a guard can reject by throwing', async () => {
    const def = route({ method: 'GET', url: '/p', meta: { auth: true }, async handler() { return 'ok' } })
    await expect(
      runRoute(def, makeRequest(), new CaptureReply(), {
        container: new Container(),
        guards: [() => { throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.') }],
      }),
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe('toErrorResponse', () => {
  it('maps HttpError, validation and unknown errors', () => {
    expect(toErrorResponse(new HttpError(404, 'NOPE', 'Not found')).status).toBe(404)
    expect(toErrorResponse(new Error('boom'))).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
    })
  })
})

describe('🟢 guards that cannot run must not be skipped', () => {
  const guarded = route({
    method: 'GET',
    url: '/secret',
    meta: { auth: true },
    handler: async () => ({ ok: true }),
  })

  it('fails closed when the pipeline has guards but no container', async () => {
    const reply = new CaptureReply()
    await expect(
      runRoute(guarded, makeRequest(), reply, { guards: [async () => { throw new Error('denied') }] }),
    ).rejects.toMatchObject({ code: 'HTTP_GUARDS_UNRUNNABLE' })
  })

  it('names the route and the number of unrunnable guards', async () => {
    const error = await runRoute(guarded, makeRequest(), new CaptureReply(), {
      guards: [async () => {}, async () => {}],
    }).catch((e: unknown) => e)
    expect((error as Error).message).toContain('GET /secret')
    expect((error as Error).message).toContain('2 route guard(s)')
  })

  it('a pipeline with no guards and no container still runs (the common case)', async () => {
    const result = await runRoute(guarded, makeRequest(), new CaptureReply(), {})
    expect(result).toEqual({ ok: true })
  })
})

describe('framework client errors stay client errors (never a 500 that pages on-call)', () => {
  // The shape of Fastify's body-parser failures (FastifyError).
  const fastifyError = (code: string, statusCode: number, message: string) =>
    Object.assign(new Error(message), { code, statusCode })

  it('maps malformed JSON, oversized and unsupported bodies to 400/413/415 with fixed messages', () => {
    const bad = toErrorResponse(fastifyError('FST_ERR_CTP_INVALID_JSON_BODY', 400, "Unexpected token 'b' in JSON"))
    expect(bad).toEqual({ status: 400, body: { error: { code: 'BAD_REQUEST', message: 'Malformed request.' } } })
    const big = toErrorResponse(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413, 'Request body is too large'))
    expect(big.status).toBe(413)
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE')
    const media = toErrorResponse(fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, 'Unsupported Media Type'))
    expect(media.status).toBe(415)
    expect(media.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('honours http-errors style client errors that declare themselves exposable', () => {
    const parse = Object.assign(new Error('Unexpected token'), { status: 400, statusCode: 400, expose: true, type: 'entity.parse.failed' })
    expect(toErrorResponse(parse).status).toBe(400)
    expect(toErrorResponse(parse).body.error.message).not.toContain('Unexpected')
  })

  it('maps a body parser SyntaxError tagged with a 400 statusCode (the Fastify adapter JSON parser)', () => {
    const parse = Object.assign(new SyntaxError('Unexpected token b in JSON at position 1'), { statusCode: 400 })
    expect(toErrorResponse(parse)).toEqual({
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'Malformed request.' } },
    })
    // An untagged SyntaxError (a handler's own JSON.parse of upstream data) stays a 500.
    expect(toErrorResponse(new SyntaxError('Unexpected token')).status).toBe(500)
  })

  it('does not trust a status carried by an arbitrary error (e.g. a failed upstream SDK call)', () => {
    const upstream = Object.assign(new Error('Invalid API key provided'), { statusCode: 401 })
    expect(toErrorResponse(upstream)).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
    })
    // A framework error outside 4xx is still a server error.
    expect(toErrorResponse(fastifyError('FST_ERR_SOMETHING', 500, 'x')).status).toBe(500)
  })
})

describe('inbound request/correlation ids are validated before they reach logs and audit trails', () => {
  const idsOf = async (headers: Record<string, string>) => {
    const reply = new CaptureReply()
    let seen: { requestId?: string; correlationId?: string } = {}
    await runRoute(
      route({
        method: 'GET',
        url: '/',
        handler: () => {
          seen = { ...tryCtx() }
          return null
        },
      }),
      makeRequest({ headers }),
      reply,
    )
    return { ...seen, echoed: reply.headers.get('x-request-id') }
  }

  it('adopts a well-formed inbound id', async () => {
    const ids = await idsOf({ 'x-request-id': 'req-123:abc.DEF_9', 'x-correlation-id': 'corr-1' })
    expect(ids.requestId).toBe('req-123:abc.DEF_9')
    expect(ids.correlationId).toBe('corr-1')
    expect(ids.echoed).toBe('req-123:abc.DEF_9')
  })

  it('replaces an oversized x-request-id with a generated one', async () => {
    const ids = await idsOf({ 'x-request-id': 'A'.repeat(8_192) })
    expect(ids.requestId).not.toContain('AAAA')
    expect(ids.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids.echoed).toBe(ids.requestId)
  })

  it('replaces ids carrying separators, spaces or control characters', async () => {
    for (const forged of ['a b', 'x\r\nlevel=error', '{"user":"admin"}', '', '../../etc']) {
      const ids = await idsOf({ 'x-request-id': forged, 'x-correlation-id': forged })
      expect(ids.requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(ids.correlationId).toBe(ids.requestId)
    }
  })
})
