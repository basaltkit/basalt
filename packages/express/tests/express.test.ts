import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, definePlugin, ensureMetadata, tryCtx, type BasaltApp } from '@basaltkit/core'
import { HttpError, route, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import { EXPRESS, expressPlugin } from '../src/index.js'

// A tenancy-like enricher + auth-like guard, registered the framework-neutral way.
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
    metadata.add('http:guarded-meta', 'auth') // this guard enforces meta.auth — claim it for the boot check
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
let base: string
let server: Server

beforeEach(async () => {
  app = await createApp({ plugins: [testPlugin, expressPlugin({ routes })] }).boot()
  server = app.container.get(EXPRESS).listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await app.shutdown()
})

describe('expressPlugin', () => {
  it('runs typed routes with params + validation', async () => {
    const hello = await fetch(`${base}/hello/world`)
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ hello: 'world', tenant: null })

    const echo = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 21 }),
    })
    expect(echo.status).toBe(201)
    expect(await echo.json()).toEqual({ doubled: 42 })

    const bad = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 'nope' }),
    })
    expect(bad.status).toBe(400)
    expect((await json(bad)).error!.code).toBe('HTTP_VALIDATION')
  })

  it('applies enrichers (tenant) and guards (auth) from the metadata buckets', async () => {
    const scoped = await fetch(`${base}/hello/x`, { headers: { 'x-tenant-id': 'acme' } })
    expect((await json(scoped)).tenant).toBe('acme')

    const denied = await fetch(`${base}/secure`)
    expect(denied.status).toBe(401)

    const allowed = await fetch(`${base}/secure`, { headers: { authorization: 'Bearer t' } })
    expect(allowed.status).toBe(200)
  })

  it('maps HttpError to its status', async () => {
    const boom = await fetch(`${base}/boom`)
    expect(boom.status).toBe(418)
    expect((await json(boom)).error!.code).toBe('TEAPOT')
  })
})

describe('urlencoded body (adapter compatibility)', () => {
  it('parses application/x-www-form-urlencoded into the body', async () => {
    const formRoutes = [
      route({ method: 'POST', url: '/form', body: z.object({ name: z.string() }), async handler({ body }) { return { got: body.name } } }),
    ]
    const a = await createApp({ plugins: [expressPlugin({ routes: formRoutes })] }).boot()
    const s = a.container.get(EXPRESS).listen(0)
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const res = await fetch(`${b}/form`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Ada',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ got: 'Ada' })
    s.close()
    await a.shutdown()
  })
})

describe('neutral 404', () => {
  it('serves the shared JSON body for unmatched routes by default', async () => {
    const res = await fetch(`${base}/definitely-not-a-route`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
  })

  it('notFound: false keeps the Express default (HTML)', async () => {
    const own = await createApp({ plugins: [testPlugin, expressPlugin({ routes, notFound: false })] }).boot()
    const server2 = own.container.get(EXPRESS).listen(0)
    await new Promise<void>((resolve) => server2.once('listening', resolve))
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`
    const res = await fetch(`${base2}/definitely-not-a-route`)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json')
    await new Promise<void>((resolve) => server2.close(() => resolve()))
    await own.shutdown()
  })
})
