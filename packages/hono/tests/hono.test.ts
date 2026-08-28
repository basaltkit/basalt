import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, definePlugin, ensureMetadata, tryCtx, type BasaltApp } from '@basaltkit/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { HONO, honoPlugin } from '../src/index.js'

const enricher: RequestEnricher = ({ request, context }) => {
  const tenant = request.headers['x-tenant-id']
  if (typeof tenant === 'string') (context as { tenant?: unknown }).tenant = { id: tenant }
}
const guard: RouteGuard = ({ route: def, request }) => {
  if (def.meta?.['auth'] && !request.headers['authorization']) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
  }
}
const testPlugin = definePlugin({
  name: 'test:http',
  register({ container }) {
    const metadata = ensureMetadata(container)
    metadata.add('http:enrichers', enricher)
    metadata.add('http:guards', guard)
  },
})

const routes = [
  route({
    method: 'GET',
    url: '/hello/:name',
    params: z.object({ name: z.string() }),
    async handler({ params }) {
      return { hello: params.name, tenant: (tryCtx() as { tenant?: { id: string } })?.tenant?.id ?? null }
    },
  }),
  route({
    method: 'POST',
    url: '/echo',
    body: z.object({ n: z.number() }),
    async handler({ body, reply }) {
      return reply.code(201).send({ doubled: body.n * 2 })
    },
  }),
  route({ method: 'GET', url: '/secure', meta: { auth: true }, async handler() { return { ok: true } } }),
  route({ method: 'GET', url: '/boom', async handler() { throw new HttpError(418, 'TEAPOT', "I'm a teapot") } }),
]

const json = (res: Response) => res.json() as Promise<{ error?: { code: string }; tenant?: string | null }>

let app: BasaltApp
let call: (path: string, init?: RequestInit) => Promise<Response>

beforeEach(async () => {
  app = await createApp({ plugins: [testPlugin, honoPlugin({ routes })] }).boot()
  const hono = app.container.get(HONO)
  call = (path, init) => Promise.resolve(hono.fetch(new Request(`http://local${path}`, init)))
})

afterEach(async () => {
  await app.shutdown()
})

describe('honoPlugin', () => {
  it('runs typed routes with params + validation', async () => {
    const hello = await call('/hello/world')
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ hello: 'world', tenant: null })

    const echo = await call('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 21 }),
    })
    expect(echo.status).toBe(201)
    expect(await echo.json()).toEqual({ doubled: 42 })

    const bad = await call('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 'nope' }),
    })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error!.code).toBe('HTTP_VALIDATION')
  })

  it('applies enrichers (tenant) and guards (auth) from the metadata buckets', async () => {
    const scoped = await call('/hello/x', { headers: { 'x-tenant-id': 'acme' } })
    expect((await json(scoped)).tenant).toBe('acme')

    expect((await call('/secure')).status).toBe(401)
    expect((await call('/secure', { headers: { authorization: 'Bearer t' } })).status).toBe(200)
  })

  it('maps HttpError to its status', async () => {
    const boom = await call('/boom')
    expect(boom.status).toBe(418)
    expect((await json(boom)).error!.code).toBe('TEAPOT')
  })
})

describe('body limit (HTTP HIGH-2)', () => {
  const mk = (bodyLimit: number) => createApp({ plugins: [honoPlugin({ routes, bodyLimit })] }).boot()

  it('rejects a body whose Content-Length exceeds the limit with 413', async () => {
    const small = await mk(16)
    const hono = small.container.get(HONO)
    const res = await hono.fetch(
      new Request('http://local/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2048' },
        body: JSON.stringify({ n: 1 }),
      }),
    )
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('PAYLOAD_TOO_LARGE')
    await small.shutdown()
  })

  it('allows a body within the limit', async () => {
    const ok = await mk(1_048_576)
    const hono = ok.container.get(HONO)
    const res = await hono.fetch(
      new Request('http://local/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 21 }),
      }),
    )
    expect(res.status).toBe(201)
    await ok.shutdown()
  })
})

describe('urlencoded body (adapter compatibility)', () => {
  it('parses application/x-www-form-urlencoded into the body', async () => {
    const formRoutes = [
      route({ method: 'POST', url: '/form', body: z.object({ name: z.string() }), async handler({ body }) { return { got: body.name } } }),
    ]
    const app = await createApp({ plugins: [honoPlugin({ routes: formRoutes })] }).boot()
    const res = await app.container.get(HONO).fetch(
      new Request('http://local/form', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=Ada',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: 'Ada' })
    await app.shutdown()
  })
})

describe('neutral 404', () => {
  it('serves the shared JSON body for unmatched routes by default', async () => {
    const res = await call('/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  it("an app's later notFound() call replaces the neutral default (last wins)", async () => {
    const own = await createApp({ plugins: [testPlugin, honoPlugin({ routes })] }).boot()
    const hono = own.container.get(HONO)
    hono.notFound((c) => c.json({ custom: true }, 404))
    const res = await hono.fetch(new Request('http://local/definitely-not-a-route'))
    expect(await res.json()).toEqual({ custom: true })
    await own.shutdown()
  })

  it('notFound: false keeps the Hono default (text)', async () => {
    const own = await createApp({ plugins: [testPlugin, honoPlugin({ routes, notFound: false })] }).boot()
    const res = await own.container.get(HONO).fetch(new Request('http://local/definitely-not-a-route'))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json')
    await own.shutdown()
  })
})
