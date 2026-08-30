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
