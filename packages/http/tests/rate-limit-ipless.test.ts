import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GUARDED_META_BUCKET,
  HttpServerCollector,
  RATE_LIMIT_META_KEY,
  assertRoutesGuarded,
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

const limited: BasaltRoute = route({
  method: 'POST',
  url: '/export',
  meta: { rateLimit: { limit: 1, windowMs: 60_000 } },
  handler: () => ({ ok: true }),
})

/** A sender whose requests carry NO `request.ip` (stdio MCP, a bare pipeline). */
async function setup() {
  const c = new HttpServerCollector()
  const app = await bootWith(c, [identity, securityPlugin({ rateLimit: { limit: 1_000, windowMs: 60_000 }, headers: false })])
  return async (who: { ip?: string; user?: string; tenant?: string }): Promise<number> => {
    const headers: Record<string, string> = {}
    if (who.user) headers['x-user'] = who.user
    if (who.tenant) headers['x-tenant'] = who.tenant
    const request = makeRequest({ method: 'POST', url: '/export', headers, raw: {}, ...(who.ip ? { ip: who.ip } : {}) })
    const reply = new FakeReply()
    if (await c.runPre(request, reply)) return reply.statusCode
    try {
      await runRoute(limited, request, reply, {
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

describe('per-route rate limit without a resolved request.ip (BK-046)', () => {
  it('gives two identified ip-less callers separate buckets', async () => {
    const send = await setup()
    expect(await send({ user: 'alice' })).toBe(200)
    expect(await send({ user: 'alice' })).toBe(429)
    expect(await send({ user: 'bob' })).toBe(200)
    // Same user in another tenant: its own bucket, as with key 'user+tenant'.
    expect(await send({ user: 'alice', tenant: 't2' })).toBe(200)
  })

  it('keeps anonymous ip-less callers in the one fail-closed `unknown` bucket', async () => {
    const send = await setup()
    expect(await send({})).toBe(200)
    expect(await send({})).toBe(429)
  })

  it('leaves requests with an ip keyed by the ip, whoever the user is', async () => {
    const send = await setup()
    expect(await send({ ip: '198.51.100.7', user: 'alice' })).toBe(200)
    expect(await send({ ip: '198.51.100.7', user: 'bob' })).toBe(429)
    expect(await send({ ip: '198.51.100.8' })).toBe(200)
  })

  it('never lets an identity bucket collide with the anonymous one', async () => {
    const send = await setup()
    expect(await send({ user: 'unknown' })).toBe(200)
    expect(await send({})).toBe(200)
  })
})

describe('boot warning for unenforced meta.rateLimit (BK-046)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())

  const boot = async (plugins: Parameters<typeof bootWith>[1] = []) =>
    (await bootWith(new HttpServerCollector(), plugins)).container

  it('warns once, naming the routes, when no limiter is registered', async () => {
    const container = await boot()
    assertRoutesGuarded([limited, route({ method: 'GET', url: '/free', handler: () => 'x' })], container)
    assertRoutesGuarded([limited], container)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/1 route\(s\) declare meta\.rateLimit.*POST \/export/)
    expect(String(warn.mock.calls[0]![0])).not.toContain('/free')
  })

  it('stays quiet when securityPlugin enforces rate limits (it claims the key)', async () => {
    const container = await boot([securityPlugin({ rateLimit: { limit: 10, windowMs: 1_000 }, headers: false })])
    expect(ensureMetadata(container).get<string>(GUARDED_META_BUCKET)).toContain(RATE_LIMIT_META_KEY)
    assertRoutesGuarded([limited], container)
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns when securityPlugin runs with its limiter off, and is silenced by allowUnguardedMeta: ['rateLimit'] or true", async () => {
    const off = await boot([securityPlugin({ headers: false })])
    assertRoutesGuarded([limited], off, ['rateLimit'])
    assertRoutesGuarded([limited], await boot(), true)
    expect(warn).not.toHaveBeenCalled()
    assertRoutesGuarded([limited], off)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ignores routes whose meta.rateLimit is false, and a set (not a container) never warns', async () => {
    const container = (await createApp({ plugins: [] }).boot()).container
    assertRoutesGuarded([route({ method: 'GET', url: '/x', meta: { rateLimit: false }, handler: () => 'x' })], container)
    assertRoutesGuarded([limited], new Set<string>())
    expect(warn).not.toHaveBeenCalled()
  })
})
