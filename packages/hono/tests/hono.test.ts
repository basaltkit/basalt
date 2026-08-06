import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, definePlugin, ensureMetadata, tryCtx, type MachizeApp } from '@machize/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@machize/http'
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

let app: MachizeApp
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
