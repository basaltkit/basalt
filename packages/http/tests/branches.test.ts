import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BasaltError } from '@basaltkit/core'
import {
  HttpServerCollector,
  RequestValidationError,
  generateOpenApi,
  healthPlugin,
  metricsPlugin,
  securityPlugin,
  toErrorResponse,
  tracingPlugin,
  zodToJsonSchema,
} from '../src/index.js'
import { MetricsRegistry, InMemorySpanExporter } from '@basaltkit/core'
import { FakeReply, bootWith, makeRequest } from './support.js'

class StatuslessError extends BasaltError {
  constructor() {
    super('X_NO_STATUS', 'no status here')
  }
}

describe('toErrorResponse — remaining branches', () => {
  it('maps a RequestValidationError to 400 with part and issues', () => {
    const res = toErrorResponse(new RequestValidationError('query', [{ path: 'page', message: 'required' }]))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: { code: 'HTTP_VALIDATION', part: 'query', issues: [{ path: 'page' }] } })
  })

  it('falls back to 500 for a BasaltError without a numeric status', () => {
    expect(toErrorResponse(new StatuslessError()).status).toBe(500)
  })
})

describe('zodToJsonSchema — full type matrix', () => {
  it('covers string checks, numbers, literals, enums and wrappers', () => {
    expect(zodToJsonSchema(z.string().email().min(2).max(5))).toMatchObject({ type: 'string', format: 'email', minLength: 2, maxLength: 5 })
    expect(zodToJsonSchema(z.string().url())).toEqual({ type: 'string', format: 'uri' })
    expect(zodToJsonSchema(z.string().regex(/^a/))).toMatchObject({ type: 'string', pattern: '^a' })
    expect(zodToJsonSchema(z.number().min(1))).toEqual({ type: 'number', minimum: 1 })
    expect(zodToJsonSchema(z.literal('x'))).toEqual({ type: 'string', enum: ['x'] })
    expect(zodToJsonSchema(z.string().optional())).toMatchObject({ type: 'string' })
    expect(zodToJsonSchema(z.string().nullable())).toMatchObject({ type: 'string', nullable: true })
    expect(zodToJsonSchema(z.string().default('d'))).toMatchObject({ type: 'string', default: 'd' })
    expect(zodToJsonSchema(z.string().refine(() => true))).toMatchObject({ type: 'string' }) // ZodEffects
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(zodToJsonSchema(z.record(z.string(), z.number()))).toMatchObject({ type: 'object', additionalProperties: { type: 'number' } })
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('handles a native enum', () => {
    enum Role {
      Admin = 'admin',
      User = 'user',
    }
    expect(zodToJsonSchema(z.nativeEnum(Role))).toMatchObject({ enum: ['admin', 'user'] })
  })
})

describe('generateOpenApi — response schemas', () => {
  it('emits per-status response content from response schemas', () => {
    const doc = generateOpenApi(
      [{ method: 'POST', url: '/things', response: { 201: z.object({ id: z.string() }) } }],
      { title: 'API', version: '1' },
    ) as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content?: unknown }> }>> }
    const op = doc.paths['/things']!['post']!
    expect(op.responses['201']!.content).toBeDefined()
  })
})

describe('healthPlugin — a check that throws', () => {
  it('reports the thrown error as a failed check', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      healthPlugin({
        checks: {
          boom: () => {
            throw new Error('kaboom')
          },
        },
      }),
    ])
    const readyz = c.extraRoutes.find((r) => r.url === '/readyz')!
    const reply = new FakeReply()
    await readyz.handler({ request: makeRequest(), reply })
    expect(reply.statusCode).toBe(503)
    const boom = (reply.payload as { checks: Record<string, { ok: boolean; detail?: string }> }).checks['boom']
    expect(boom).toEqual({ ok: false }) // fails, but the raw error text is NOT leaked
    expect(boom).not.toHaveProperty('detail')
  })
})

describe('securityPlugin — CORS credentials do not reflect an arbitrary origin', () => {
  it('refuses to reflect the request Origin when credentials are enabled (no allowlist)', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ headers: false, cors: { credentials: true } })])
    const reply = new FakeReply()
    await c.runPre(makeRequest({ headers: { origin: 'https://evil.test' } }), reply)
    // No Access-Control-Allow-Origin at all → the browser blocks the credentialed read.
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined()
  })
})

describe('metricsPlugin — routes without a template', () => {
  it("labels an untemplated request as 'unknown'", async () => {
    const registry = new MetricsRegistry()
    const c = new HttpServerCollector()
    await bootWith(c, [metricsPlugin({ registry })])
    const request = makeRequest({ method: 'GET', url: '/whatever' }) // no routePattern
    await c.runPre(request, new FakeReply())
    await c.runAfter(request, new FakeReply(), 200, 1)
    expect(registry.render()).toContain('route="unknown"')
  })
})

describe('securityPlugin — header and CORS option branches', () => {
  it('applies configured header options', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [
      securityPlugin({
        headers: {
          hsts: { maxAge: 100, includeSubDomains: false, preload: true },
          frameOptions: false,
          referrerPolicy: false,
          crossOriginOpenerPolicy: false,
          contentSecurityPolicy: "default-src 'self'",
        },
      }),
    ])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['strict-transport-security']).toBe('max-age=100; preload')
    expect(reply.headers['x-frame-options']).toBeUndefined()
    expect(reply.headers['referrer-policy']).toBeUndefined()
    expect(reply.headers['cross-origin-opener-policy']).toBeUndefined()
    expect(reply.headers['content-security-policy']).toBe("default-src 'self'")
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
  })

  it('supports a fixed origin with credentials and exposed headers', async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ headers: false, cors: { origin: 'https://fixed.test', credentials: true, exposedHeaders: ['X-Total'] } })])
    const reply = new FakeReply()
    await c.runPre(makeRequest({ headers: { origin: 'https://fixed.test' } }), reply)
    expect(reply.headers['access-control-allow-origin']).toBe('https://fixed.test')
    expect(reply.headers['vary']).toBe('Origin')
    expect(reply.headers['access-control-allow-credentials']).toBe('true')
    expect(reply.headers['access-control-expose-headers']).toBe('X-Total')
  })

  it('supports a function origin and a disabled origin', async () => {
    const fn = new HttpServerCollector()
    await bootWith(fn, [securityPlugin({ headers: false, cors: { origin: (o) => o === 'https://ok.test' } })])
    const good = new FakeReply()
    await fn.runPre(makeRequest({ headers: { origin: 'https://ok.test' } }), good)
    expect(good.headers['access-control-allow-origin']).toBe('https://ok.test')
    const bad = new FakeReply()
    await fn.runPre(makeRequest({ headers: { origin: 'https://no.test' } }), bad)
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()

    const off = new HttpServerCollector()
    await bootWith(off, [securityPlugin({ headers: false, cors: { origin: false } })])
    const reply = new FakeReply()
    await off.runPre(makeRequest({ headers: { origin: 'https://any.test' } }), reply)
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
  })

  it("defaults an origin-less request to '*' without Vary", async () => {
    const c = new HttpServerCollector()
    await bootWith(c, [securityPlugin({ headers: false, cors: { origin: true } })])
    const reply = new FakeReply()
    await c.runPre(makeRequest(), reply)
    expect(reply.headers['access-control-allow-origin']).toBe('*')
    expect(reply.headers['vary']).toBeUndefined()
  })
})

describe('tracingPlugin — edge branches', () => {
  it('reads a traceparent supplied as a header array', async () => {
    const exporter = new InMemorySpanExporter()
    const c = new HttpServerCollector()
    const app = await bootWith(c, [tracingPlugin({ exporter })])
    const traceId = '11112222333344445555666677778888'
    const reply = new FakeReply()
    await c.runPre(makeRequest({ headers: { traceparent: [`00-${traceId}-1111111111111111-01`] }, routePattern: '/x' }), reply)
    expect(reply.headers['traceparent']).toContain(traceId)
    await app.shutdown()
  })

  it('after-hook is a no-op when no span was started', async () => {
    const c = new HttpServerCollector()
    const app = await bootWith(c, [tracingPlugin({ exporter: new InMemorySpanExporter() })])
    // runAfter without a preceding runPre → request.raw has no span
    await expect(c.runAfter(makeRequest(), new FakeReply(), 200, 1)).resolves.toBeUndefined()
    await app.shutdown()
  })

  it('names the span by URL when there is no route template', async () => {
    const exporter = new InMemorySpanExporter()
    const c = new HttpServerCollector()
    const app = await bootWith(c, [tracingPlugin({ exporter })])
    const request = makeRequest({ method: 'GET', url: '/raw/path' }) // no routePattern
    await c.runPre(request, new FakeReply())
    await c.runAfter(request, new FakeReply(), 200, 1)
    await app.shutdown()
    expect(exporter.spans[0]!.name).toBe('GET /raw/path')
  })
})

describe('final branch closers', () => {
  it('zodToJsonSchema returns {} for a non-Zod value', () => {
    expect(zodToJsonSchema({} as never)).toEqual({})
  })

  it('healthPlugin with no checks is ready, and hides the text of a non-Error throw', async () => {
    const empty = new HttpServerCollector()
    await bootWith(empty, [healthPlugin()]) // no checks → ?? {}
    const readyz = empty.extraRoutes.find((r) => r.url === '/readyz')!
    const reply = new FakeReply()
    const body = await readyz.handler({ request: makeRequest(), reply })
    expect(reply.sent).toBe(false)
    expect(body).toMatchObject({ status: 'ok' })

    const c = new HttpServerCollector()
    await bootWith(c, [
      healthPlugin({
        checks: {
          weird: () => {
            throw 'plain string' // non-Error
          },
        },
      }),
    ])
    const reply2 = new FakeReply()
    await c.extraRoutes.find((r) => r.url === '/readyz')!.handler({ request: makeRequest(), reply: reply2 })
    const weird = (reply2.payload as { checks: Record<string, { ok: boolean; detail?: string }> }).checks['weird']
    expect(weird).toEqual({ ok: false }) // the raw thrown text never reaches the client
    expect(weird).not.toHaveProperty('detail')
  })

  it('security: rate-limit skip, x-forwarded-for key, and preflight defaults', async () => {
    // skip predicate → never limited
    const skipC = new HttpServerCollector()
    await bootWith(skipC, [securityPlugin({ headers: false, rateLimit: { limit: 1, windowMs: 1000, skip: () => true } })])
    await skipC.runPre(makeRequest(), new FakeReply())
    const second = new FakeReply()
    expect(await skipC.runPre(makeRequest(), second)).toBe(false) // not blocked

    // no ip → client key comes from x-forwarded-for (array form)
    const fwdC = new HttpServerCollector()
    await bootWith(fwdC, [securityPlugin({ headers: false, rateLimit: { limit: 1, windowMs: 1000 } })])
    const r1 = new FakeReply()
    await fwdC.runPre(makeRequest({ headers: { 'x-forwarded-for': ['9.9.9.9'] } }), r1)
    expect(r1.headers['x-ratelimit-remaining']).toBe('0')

    // preflight with no configured methods/allowedHeaders → defaults + echo requested
    const corsC = new HttpServerCollector()
    await bootWith(corsC, [securityPlugin({ headers: false, cors: { origin: true } })])
    const reply = new FakeReply()
    await corsC.runPre(
      makeRequest({ method: 'OPTIONS', headers: { origin: 'https://a.test', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'x-custom' } }),
      reply,
    )
    expect(reply.statusCode).toBe(204)
    expect(reply.headers['access-control-allow-methods']).toContain('DELETE')
    expect(reply.headers['access-control-allow-headers']).toBe('x-custom')
  })
})
