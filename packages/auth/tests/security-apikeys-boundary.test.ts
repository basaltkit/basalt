import { afterEach, describe, expect, it } from 'vitest'
import { ctx, definePlugin, ensureMetadata, type BasaltPlugin } from '@basaltkit/core'
import { route, type RequestEnricher } from '@basaltkit/http'
import {
  ApiKeys,
  MemoryApiKeyStore,
  MemoryUserSource,
  apiKeyRoutes,
  apiKeysPlugin,
  authPlugin,
  authRoutes,
  mfaRoutes,
  type ApiKeysPluginOptions,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * Security invariants for API keys:
 *  - a key is bound to the tenant it was issued in (F01);
 *  - a key's scopes are an upper bound on what it can reach, and session-only
 *    routes (key management, MFA) refuse key-authenticated callers (F02).
 */

const secret = 'test-secret-test-secret-test-secret'

/** Stand-in for @basaltkit/tenancy: resolves ctx().tenant from `x-tenant-id` (client-controlled). */
const headerTenancy = (): BasaltPlugin =>
  definePlugin({
    name: 'test:tenancy',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        const id = request.headers['x-tenant-id']
        if (typeof id === 'string') (context as { tenant?: { id: string } }).tenant = { id }
      }
      ensureMetadata(container).add('http:enrichers', enricher)
    },
  })

const businessRoutes = [
  route({
    method: 'GET',
    url: '/orders',
    meta: { scopes: ['orders:read'] },
    handler: () => ({ servedTenant: (ctx() as { tenant?: { id: string } }).tenant?.id ?? null, keyTenant: ctx().apiKey?.tenantId ?? null }),
  }),
  route({
    method: 'GET',
    url: '/central/health-report',
    meta: { scopes: ['orders:read'], central: true },
    handler: () => ({ ok: true }),
  }),
  route({
    method: 'POST',
    url: '/team/invite',
    meta: { auth: true },
    handler: () => ({ invited: true, by: ctx().user?.id }),
  }),
]

let harness: Harness | undefined
/** Issues machine keys straight into the booted app's store (no route, no tenant). */
let keysService: ApiKeys | undefined
const harnessKeys = (_h: Harness): ApiKeys => keysService!
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number], keyOptions: ApiKeysPluginOptions = {}) {
  const users = new MemoryUserSource()
  const store = new MemoryApiKeyStore()
  keysService = new ApiKeys({ store })
  harness = await boot(
    adapter,
    [
      headerTenancy(),
      authPlugin({ users, secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false }),
      apiKeysPlugin({ users, store, ...keyOptions }),
    ],
    [...authRoutes({ rateLimit: false }), ...apiKeyRoutes(), ...mfaRoutes(), ...businessRoutes],
  )
  const h = harness
  const reg = await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'eve@acme.test', password: 'password123' } })
  expect(reg.status).toBe(202)
  const login = await h.call({ method: 'POST', url: '/auth/login', payload: { email: 'eve@acme.test', password: 'password123' } })
  const access = login.body.accessToken as string
  return { h, access }
}

const mintKey = async (h: Harness, access: string, tenant: string, body: Record<string, unknown>) => {
  const res = await h.call({
    method: 'POST',
    url: '/apikeys',
    headers: { authorization: `Bearer ${access}`, 'x-tenant-id': tenant },
    payload: body,
  })
  expect(res.status).toBe(201)
  return res.body as { id: string; key: string; tenantId?: string; scopes: string[] }
}

describe.each(availableAdapters)('API keys are bound to their tenant (%s)', (adapter) => {
  it('a key issued in tenant A is refused when the request resolves tenant B', async () => {
    const { h, access } = await setup(adapter)
    const { key } = await mintKey(h, access, 'acme', { name: 'x', scopes: ['orders:read'] })

    const own = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key, 'x-tenant-id': 'acme' } })
    expect(own.status).toBe(200)
    expect(own.body).toEqual({ servedTenant: 'acme', keyTenant: 'acme' })

    const cross = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key, 'x-tenant-id': 'globex' } })
    expect(cross.status).toBe(403)
    expect(cross.body.error.code).toBe('AUTH_APIKEY_TENANT_MISMATCH')

    // Same key as a Bearer credential — the alternate presentation path.
    const bearer = await h.call({ method: 'GET', url: '/orders', headers: { authorization: `Bearer ${key}`, 'x-tenant-id': 'globex' } })
    expect(bearer.status).toBe(403)
  })

  it('a tenant-bound key is refused when no tenant is resolved (it cannot escape to central routes)', async () => {
    const { h, access } = await setup(adapter)
    const { key } = await mintKey(h, access, 'acme', { name: 'x', scopes: ['orders:read'] })
    const res = await h.call({ method: 'GET', url: '/central/health-report', headers: { 'x-api-key': key } })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_APIKEY_TENANT_MISMATCH')
  })

  it('a tenantless (machine) key is refused on a tenant-scoped request unless explicitly allowed', async () => {
    const { h } = await setup(adapter)
    const { key } = await harnessKeys(h).issue({ name: 'machine', scopes: ['orders:read'] })
    const res = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key, 'x-tenant-id': 'globex' } })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_APIKEY_TENANT_MISMATCH')
    // …but it still works where no tenant is in play.
    const central = await h.call({ method: 'GET', url: '/central/health-report', headers: { 'x-api-key': key } })
    expect(central.status).toBe(200)
  })

  it('allowTenantlessKeys opts platform keys back in', async () => {
    const { h } = await setup(adapter, { allowTenantlessKeys: true })
    const { key } = await harnessKeys(h).issue({ name: 'machine', scopes: ['orders:read'] })
    const res = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key, 'x-tenant-id': 'globex' } })
    expect(res.status).toBe(200)
  })
})

describe.each(availableAdapters)('API-key scopes are an upper bound (%s)', (adapter) => {
  it('a key cannot mint another key (key management is session-only)', async () => {
    const { h, access } = await setup(adapter)
    const narrow = await mintKey(h, access, 'acme', { name: 'reports', scopes: ['orders:read'] })
    const res = await h.call({
      method: 'POST',
      url: '/apikeys',
      headers: { 'x-api-key': narrow.key, 'x-tenant-id': 'acme' },
      payload: { name: 'escalated' },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_APIKEY_NOT_ALLOWED')

    // Even a '*' key must not manage keys or MFA — those need an interactive session.
    const star = await mintKey(h, access, 'acme', { name: 'all', scopes: ['*'] })
    for (const req of [
      { method: 'POST', url: '/apikeys', payload: { name: 'child' } },
      { method: 'GET', url: '/apikeys' },
      { method: 'DELETE', url: `/apikeys/${narrow.id}` },
      { method: 'POST', url: '/auth/mfa/enroll' },
      { method: 'POST', url: '/auth/mfa/disable', payload: { code: '123456' } },
    ]) {
      const r = await h.call({ ...req, headers: { 'x-api-key': star.key, 'x-tenant-id': 'acme' } })
      expect(r.status, `${req.method} ${req.url}`).toBe(403)
    }
  })

  it('a narrow key cannot act as its owner on routes that do not declare its scopes', async () => {
    const { h, access } = await setup(adapter)
    const narrow = await mintKey(h, access, 'acme', { name: 'reports', scopes: ['orders:read'] })
    const res = await h.call({ method: 'POST', url: '/team/invite', headers: { 'x-api-key': narrow.key, 'x-tenant-id': 'acme' } })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_SCOPE_REQUIRED')

    // A '*' key is the owner's full delegate — it may act as the user.
    const star = await mintKey(h, access, 'acme', { name: 'all', scopes: ['*'] })
    const ok = await h.call({ method: 'POST', url: '/team/invite', headers: { 'x-api-key': star.key, 'x-tenant-id': 'acme' } })
    expect(ok.status).toBe(200)
  })
})

