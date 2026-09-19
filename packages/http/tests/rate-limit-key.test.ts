import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  HttpServerCollector,
  route,
  runRoute,
  securityPlugin,
  toErrorResponse,
  type BasaltRoute,
  type RequestEnricher,
  type RouteGuard,
} from '../src/index.js'
import { FakeReply, bootWith, makeRequest } from './support.js'

/** Resolves `ctx().user` / `ctx().tenant` from headers, like auth + tenancy enrichers do. */
const identity = definePlugin({
  name: 'test:identity',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const user = request.headers['x-user']
      const tenant = request.headers['x-tenant']
      if (typeof user === 'string') context['user'] = { id: user }
      if (typeof tenant === 'string') context['tenant'] = { id: tenant }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const routesProvider = (routes: BasaltRoute[]) =>
  definePlugin({
    name: 'test:routes',
    boot({ container }) {
      for (const r of routes) ensureMetadata(container).add('http:routes', { method: r.method, url: r.url, meta: r.meta ?? {} })
    },
  })

const limited = (key: unknown) =>
  route({
    method: 'POST',
    url: '/export',
    meta: { rateLimit: { limit: 1, windowMs: 60_000, key } },
    handler: () => ({ ok: true }),
  })

interface Who {
  ip?: string
  user?: string
  tenant?: string
  /** Fastify: the pre-hook already knows the matched route. */
  routed?: boolean
}

async function setup(definition: BasaltRoute, routed = false) {
  const c = new HttpServerCollector()
  const app = await bootWith(c, [
    identity,
    ...(routed ? [routesProvider([definition])] : []),
    securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false }),
  ])
  return async (who: Who): Promise<number> => {
    const headers: Record<string, string> = {}
    if (who.user) headers['x-user'] = who.user
    if (who.tenant) headers['x-tenant'] = who.tenant
    const request = makeRequest({
      method: 'POST',
      url: '/export',
      ip: who.ip ?? '203.0.113.10',
      headers,
      raw: {},
      ...(routed ? { routePattern: '/export' } : {}),
    })
    const reply = new FakeReply()
    if (await c.runPre(request, reply)) return reply.statusCode
    try {
      await runRoute(definition, request, reply, {
        container: app.container,
        enrichers: ensureMetadata(app.container).get<RequestEnricher>('http:enrichers'),
        guards: ensureMetadata(app.container).get<RouteGuard>('http:guards'),
      })
      return reply.statusCode
    } catch (error) {
      return toErrorResponse(error).status
    }
  }
}

describe('meta.rateLimit.key — per-route buckets keyed by user / tenant (BK-008)', () => {
  for (const routed of [false, true]) {
    const label = routed ? 'pre-hook knows the route (Fastify)' : 'guard-only (Express/Hono)'

    it(`key 'user': two users behind the same IP get separate buckets — ${label}`, async () => {
      const send = await setup(limited('user'), routed)
      expect(await send({ user: 'alice' })).toBe(200)
      expect(await send({ user: 'alice' })).toBe(429)
      expect(await send({ user: 'bob' })).toBe(200)
    })

    it(`key 'tenant': users of one tenant share a bucket — ${label}`, async () => {
      const send = await setup(limited('tenant'), routed)
      expect(await send({ user: 'alice', tenant: 't1' })).toBe(200)
      expect(await send({ user: 'bob', tenant: 't1' })).toBe(429)
      expect(await send({ user: 'carol', tenant: 't2' })).toBe(200)
    })

    it(`key 'user+tenant': one user in two tenants gets two buckets — ${label}`, async () => {
      const send = await setup(limited('user+tenant'), routed)
      expect(await send({ user: 'alice', tenant: 't1' })).toBe(200)
      expect(await send({ user: 'alice', tenant: 't1' })).toBe(429)
      expect(await send({ user: 'alice', tenant: 't2' })).toBe(200)
      expect(await send({ user: 'bob', tenant: 't1' })).toBe(200)
    })

    it(`falls back to the client IP when there is no user/tenant — ${label}`, async () => {
      const send = await setup(limited('user'), routed)
      expect(await send({ ip: '198.51.100.1' })).toBe(200)
      expect(await send({ ip: '198.51.100.1' })).toBe(429)
      expect(await send({ ip: '198.51.100.2' })).toBe(200)
      // An anonymous caller never shares a bucket with a signed-in one.
      expect(await send({ ip: '198.51.100.1', user: 'alice' })).toBe(200)
    })

    it(`accepts a function of ctx() — ${label}`, async () => {
      const send = await setup(
        limited((context: Record<string, unknown>) => (context['tenant'] as { id: string } | undefined)?.id),
        routed,
      )
      expect(await send({ tenant: 'acme' })).toBe(200)
      expect(await send({ tenant: 'acme', ip: '192.0.2.99' })).toBe(429)
      expect(await send({ tenant: 'globex' })).toBe(200)
      // Returning nothing falls back to the IP.
      expect(await send({ ip: '192.0.2.50' })).toBe(200)
      expect(await send({ ip: '192.0.2.50' })).toBe(429)
    })
  }

  it("key 'ip' (and no key) keep the historical per-IP bucket", async () => {
    for (const key of ['ip', undefined]) {
      const send = await setup(limited(key))
      expect(await send({ user: 'alice' })).toBe(200)
      expect(await send({ user: 'bob' })).toBe(429)
    }
  })

  it('a user-keyed id cannot collide with an IP-keyed bucket', async () => {
    const send = await setup(limited('user'))
    expect(await send({ user: '203.0.113.10' })).toBe(200)
    // The anonymous caller from that address has its own, untouched bucket.
    expect(await send({ ip: '203.0.113.10' })).toBe(200)
  })
})
