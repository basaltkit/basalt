import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ctx, definePlugin, ensureMetadata } from '@basaltkit/core'
import { HttpError, route, type RouteGuard } from '@basaltkit/http'
import { fastifyPlugin } from '@basaltkit/fastify'
import { expressPlugin } from '@basaltkit/express'
import { honoPlugin } from '@basaltkit/hono'
import { createTestApp, type TestAdapterName, type TestApp, type TestResponse } from '../src/index.js'

/**
 * Cross-adapter conformance (ecosystem review 2026-08, finding Q1).
 *
 * One suite, three adapters: every behavior of the neutral HTTP contract —
 * routing/params/query, body validation and its 400 shape, guards (auth-style
 * meta), enrichers (the harness's impersonation), custom status codes, and the
 * HttpError → JSON error mapping — must be indistinguishable across Fastify,
 * Express and Hono. A drift like finding A1 (features quietly assuming one
 * adapter) shows up here as a per-adapter failure.
 *
 * Lives in @basaltkit/testing (not @basaltkit/http) because the harness and
 * all three adapters are already dependencies here; http hosting it would
 * invert the dependency graph (http must not depend on its adapters).
 */

const routes = [
  route({
    method: 'GET',
    url: '/hello/:name',
    params: z.object({ name: z.string() }),
    query: z.object({ shout: z.string().optional() }),
    async handler({ params, query }) {
      const name = query.shout === 'yes' ? params.name.toUpperCase() : params.name
      return { hello: name }
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
  route({
    method: 'GET',
    url: '/secure',
    meta: { auth: true },
    async handler() {
      return { ok: true }
    },
  }),
  route({
    method: 'GET',
    url: '/whoami',
    async handler() {
      const { user, tenant } = ctx()
      return { user: user ?? null, tenant: tenant ?? null }
    },
  }),
  route({
    method: 'GET',
    url: '/boom',
    async handler() {
      throw new HttpError(418, 'TEAPOT', "I'm a teapot")
    },
  }),
]

/** Auth-style guard registered the framework-neutral way (like @basaltkit/auth). */
const guard: RouteGuard = ({ route: definition, request }) => {
  if (definition.meta?.['auth'] && !request.headers['authorization']) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
  }
}
const guardPlugin = definePlugin({
  name: 'test:guard',
  register({ container }) {
    ensureMetadata(container).add('http:guards', guard)
  },
})

const ADAPTERS: { name: TestAdapterName; plugin: () => unknown }[] = [
  { name: 'fastify', plugin: () => fastifyPlugin({ routes }) },
  { name: 'express', plugin: () => expressPlugin({ routes }) },
  { name: 'hono', plugin: () => honoPlugin({ routes }) },
]

describe.each(ADAPTERS)('neutral HTTP contract on $name', ({ name, plugin }) => {
  let app: TestApp<TestResponse>

  const boot = async () => {
    app = await createTestApp({
      adapter: name,
      plugins: [guardPlugin, plugin() as never],
    })
    return app
  }

  afterEach(async () => {
    await app?.shutdown()
  })

  it('routes with params and query validation', async () => {
    await boot()
    const plain = await app.get('/hello/world')
    expect(plain.statusCode).toBe(200)
    expect(plain.json()).toEqual({ hello: 'world' })

    const shouted = await app.get('/hello/world?shout=yes')
    expect(shouted.statusCode).toBe(200)
    expect(shouted.json()).toEqual({ hello: 'WORLD' })
  })

  it('validates the body and reports the standard 400 shape', async () => {
    await boot()
    const bad = await app.post('/echo', { n: 'not-a-number' })
    expect(bad.statusCode).toBe(400)
    const body = bad.json<{ error: { code: string; part: string; issues: { path: string }[] } }>()
    expect(body.error.code).toBe('HTTP_VALIDATION')
    expect(body.error.part).toBe('body')
    expect(body.error.issues).toHaveLength(1)
    expect(body.error.issues[0]!.path).toBe('n')
  })

  it('honors reply.code() for created resources', async () => {
    await boot()
    const created = await app.post('/echo', { n: 21 })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toEqual({ doubled: 42 })
  })

  it('guards reject before the handler with the standard error body', async () => {
    await boot()
    const denied = await app.get('/secure')
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toEqual({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication required.' },
    })

    const allowed = await app.get('/secure', { headers: { authorization: 'Bearer x' } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json()).toEqual({ ok: true })
  })

  it('impersonation (enrichers) works identically', async () => {
    await boot()
    app.actingAs({ id: 'u1', email: 'ada@example.com' }).asTenant('acme')
    const who = await app.get('/whoami')
    expect(who.statusCode).toBe(200)
    expect(who.json()).toEqual({
      user: { id: 'u1', email: 'ada@example.com' },
      tenant: { id: 'acme' },
    })

    // per-request override wins over the defaults
    const overridden = await app.get('/whoami', { tenant: 'globex' })
    expect(overridden.json<{ tenant: { id: string } }>().tenant).toEqual({ id: 'globex' })
  })

  it('maps HttpError thrown in a handler to its status + error body', async () => {
    await boot()
    const boom = await app.get('/boom')
    expect(boom.statusCode).toBe(418)
    expect(boom.json()).toEqual({ error: { code: 'TEAPOT', message: "I'm a teapot" } })
  })

  it('unknown routes serve the neutral JSON 404 — full body parity', async () => {
    await boot()
    const missing = await app.get('/definitely-not-a-route')
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
    expect(String(missing.headers['content-type'])).toContain('application/json')
  })
})
