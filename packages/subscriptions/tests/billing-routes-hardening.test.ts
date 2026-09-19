import { describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { HttpError, type BasaltRoute, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import {
  billingRoutes,
  definePlans,
  FakeBillingGateway,
  subscriptionsPlugin,
  type BillingRoutesOptions,
} from '../src/index.js'

/**
 * B09/F39: billing routes mint live payment-management URLs.
 *  1. The per-request success/cancel/return URL overrides must stay on the
 *     app's own origins (configured URLs + `allowedRedirectOrigins`) — otherwise
 *     a legitimate checkout/portal link becomes an open redirect to any site.
 *  2. `billingRoutes({ meta })` lets the app require a billing role (e.g.
 *     `teamRole: 'owner'`) so the lowest-privilege member cannot manage billing.
 * Enforced identically on Fastify, Express and Hono.
 */

const plans = definePlans({ pro: { price: 29, features: { api: true } } })
const urls = { successUrl: 'https://app.test/billing/ok', cancelUrl: 'https://app.test/billing/no' }

/** Tenant from x-tenant-id, user from `Bearer good`, team role from x-role. */
const fakeIdentity = definePlugin({
  name: 'fake-identity',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const tenant = request.headers['x-tenant-id']
      if (typeof tenant === 'string') context.tenant = { id: tenant }
      if (request.headers['authorization'] === 'Bearer good') {
        context.user = { id: 'u1', role: request.headers['x-role'] }
      }
    }
    const rank: Record<string, number> = { owner: 3, admin: 2, member: 1 }
    const guard: RouteGuard = ({ route, context }) => {
      if (route.meta?.['auth'] && !context.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
      const required = route.meta?.['teamRole'] as string | undefined
      if (required) {
        const role = (context.user as { role?: string } | undefined)?.role ?? ''
        if ((rank[role] ?? 0) < (rank[required] ?? Infinity)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Forbidden.')
      }
    }
    const metadata = ensureMetadata(container)
    metadata.add('http:enrichers', enricher)
    metadata.add('http:guards', guard)
    metadata.add('http:guarded-meta', 'auth')
    metadata.add('http:guarded-meta', 'teamRole')
  },
})

type Live = { url: string; gateway: FakeBillingGateway; close: () => Promise<void> }

async function start(adapter: string, routes: BasaltRoute[]): Promise<Live> {
  const gateway = new FakeBillingGateway()
  const base = [fakeIdentity, subscriptionsPlugin({ plans, gateway })]
  if (adapter === 'fastify') {
    const app = await createApp({ plugins: [...base, fastifyPlugin({ routes })] }).boot()
    const server = app.container.get(FASTIFY)
    await server.listen({ port: 0, host: '127.0.0.1' })
    const addr = server.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { url: `http://127.0.0.1:${port}`, gateway, close: () => app.shutdown() }
  }
  if (adapter === 'express') {
    const app = await createApp({ plugins: [...base, expressPlugin({ routes })] }).boot()
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { url: `http://127.0.0.1:${port}`, gateway, close: () => new Promise<void>((r) => server.close(() => r())) }
  }
  const app = await createApp({ plugins: [...base, honoPlugin({ routes })] }).boot()
  const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>((resolve) => {
    const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
      resolve({ server: s as unknown as { close: (cb: () => void) => void }, port: info.port }),
    )
  })
  return { url: `http://127.0.0.1:${port}`, gateway, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const post = (live: Live, path: string, body: unknown, role = 'owner') =>
  fetch(`${live.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'x-tenant-id': 'acme', 'x-role': role },
    body: JSON.stringify(body),
  })

const withLive = async (adapter: string, options: BillingRoutesOptions, fn: (live: Live) => Promise<void>) => {
  const live = await start(adapter, billingRoutes(options))
  try {
    await fn(live)
  } finally {
    await live.close()
  }
}

describe.each(['fastify', 'express', 'hono'])('billingRoutes redirect/role hardening on %s', (adapter) => {
  it('rejects a checkout successUrl/cancelUrl on a foreign origin (open redirect) with 400', async () => {
    await withLive(adapter, urls, async (live) => {
      for (const body of [
        { plan: 'pro', successUrl: 'https://evil.example/phish' },
        { plan: 'pro', cancelUrl: 'https://evil.example/phish' },
        { plan: 'pro', successUrl: 'https://app.test@evil.example/' }, // userinfo trick
        { plan: 'pro', successUrl: 'https://app.test.evil.example/' }, // suffix trick
        { plan: 'pro', successUrl: 'http://app.test/billing/ok' }, // scheme downgrade
      ]) {
        const res = await post(live, '/billing/checkout', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      expect(live.gateway.checkouts).toHaveLength(0) // no session was minted
    })
  })

  it('rejects a portal returnUrl on a foreign origin with 400', async () => {
    await withLive(adapter, urls, async (live) => {
      const res = await post(live, '/billing/portal', { returnUrl: 'https://evil.example/' })
      expect(res.status).toBe(400)
      expect(live.gateway.portals).toHaveLength(0)
    })
  })

  it('accepts overrides on the configured origin and on allowedRedirectOrigins', async () => {
    await withLive(adapter, { ...urls, allowedRedirectOrigins: ['https://www.app.test'] }, async (live) => {
      const a = await post(live, '/billing/checkout', { plan: 'pro', successUrl: 'https://app.test/welcome?x=1' })
      expect(a.status).toBe(200)
      const b = await post(live, '/billing/portal', { returnUrl: 'https://www.app.test/settings' })
      expect(b.status).toBe(200)
      expect(live.gateway.checkouts[0]!.successUrl).toBe('https://app.test/welcome?x=1')
      expect(live.gateway.portals[0]!.returnUrl).toBe('https://www.app.test/settings')
    })
  })

  it('an opaque ("null") origin is never an allowed redirect, even when a configured URL has one', async () => {
    // A mobile deep link has origin "null" — so do javascript:, data: and
    // file: URLs. Comparing origins alone would let every one of them through.
    await withLive(adapter, { ...urls, cancelUrl: 'myapp://billing/cancel' }, async (live) => {
      for (const body of [
        { plan: 'pro', successUrl: 'javascript:alert(document.cookie)' },
        { plan: 'pro', successUrl: 'data:text/html,<script>alert(1)</script>' },
        { plan: 'pro', cancelUrl: 'file:///etc/passwd' },
        { plan: 'pro', cancelUrl: 'myapp://billing/other' },
      ]) {
        const res = await post(live, '/billing/checkout', body)
        expect(res.status, JSON.stringify(body)).toBe(400)
      }
      expect(live.gateway.checkouts).toHaveLength(0)
      // The configured deep link itself still works (no override).
      expect((await post(live, '/billing/checkout', { plan: 'pro' })).status).toBe(200)
    })
  })

  it('meta option: a plain member cannot open checkout/portal when the app requires teamRole owner', async () => {
    await withLive(adapter, { ...urls, meta: { teamRole: 'owner' } }, async (live) => {
      expect((await post(live, '/billing/portal', {}, 'member')).status).toBe(403)
      expect((await post(live, '/billing/checkout', { plan: 'pro' }, 'member')).status).toBe(403)
      expect((await post(live, '/billing/portal', {}, 'owner')).status).toBe(200)
    })
  })

  it('meta option cannot switch authentication off (auth stays required)', async () => {
    await withLive(adapter, { ...urls, meta: { auth: false } as never }, async (live) => {
      const res = await fetch(`${live.url}/billing/portal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: '{}',
      })
      expect(res.status).toBe(401)
    })
  })
})

describe('billingRoutes configuration', () => {
  it('rejects a non-https allowedRedirectOrigins entry (except localhost)', () => {
    expect(() => billingRoutes({ ...urls, allowedRedirectOrigins: ['http://partner.example'] })).toThrow(/https/)
    expect(() => billingRoutes({ ...urls, allowedRedirectOrigins: ['not a url'] })).toThrow()
    expect(() => billingRoutes({ ...urls, allowedRedirectOrigins: ['http://localhost:5173'] })).not.toThrow()
  })
})
