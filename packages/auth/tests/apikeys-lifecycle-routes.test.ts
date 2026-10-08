import { afterEach, describe, expect, it } from 'vitest'
import {
  ApiKeys,
  MemoryApiKeyStore,
  MemoryUserSource,
  apiKeyRoutes,
  apiKeysPlugin,
  authPlugin,
  authRoutes,
  type ApiKeyStore,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/** BK-083 (c)/(f): PATCH, rotate and `?includeExpired` on `apiKeyRoutes()`, identical on every adapter. */

const secret = 'test-secret-test-secret-test-secret'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(adapter: (typeof availableAdapters)[number], store: ApiKeyStore = new MemoryApiKeyStore()) {
  const users = new MemoryUserSource()
  harness = await boot(
    adapter,
    [
      authPlugin({ users, secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false }),
      apiKeysPlugin({ users, store }),
    ],
    [...authRoutes({ rateLimit: false }), ...apiKeyRoutes()],
  )
  const h = harness
  const session = async (email: string) => {
    await h.call({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
    const login = await h.call({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
    return { authorization: `Bearer ${login.body.accessToken as string}` }
  }
  const ana = await session('ana@example.com')
  const mint = async (headers: Record<string, string>, body: Record<string, unknown> = { name: 'ci' }) => {
    const res = await h.call({ method: 'POST', url: '/apikeys', headers, payload: body })
    expect(res.status).toBe(201)
    return res.body as { id: string; key: string }
  }
  return { h, ana, session, mint, store }
}

describe.each(availableAdapters)('%s: API key lifecycle routes (BK-083)', (adapter) => {
  it('PATCH changes the mutable fields in one call and returns the key without hashes', async () => {
    const { h, ana, mint } = await setup(adapter)
    const { id } = await mint(ana)
    const res = await h.call({
      method: 'PATCH',
      url: `/apikeys/${id}`,
      headers: ana,
      payload: { name: 'renamed', scopes: ['orders:read'], expiresAt: Date.now() + 3_600_000, allowedIps: ['10.0.0.0/8'], meta: { ticket: 'OPS-1' } },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id, name: 'renamed', scopes: ['orders:read'], allowedIps: ['10.0.0.0/8'], meta: { ticket: 'OPS-1' } })
    expect(res.body).not.toHaveProperty('hash')
    const cleared = await h.call({ method: 'PATCH', url: `/apikeys/${id}`, headers: ana, payload: { expiresAt: null, allowedIps: null, meta: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.expiresAt).toBeUndefined()
    expect(cleared.body.allowedIps).toBeUndefined()
    expect(cleared.body.meta).toBeUndefined()
  })

  it('PATCH refuses invalid input with a stable code', async () => {
    const { h, ana, mint } = await setup(adapter)
    const { id } = await mint(ana)
    const badCidr = await h.call({ method: 'PATCH', url: `/apikeys/${id}`, headers: ana, payload: { allowedIps: ['10.0.0.5/8'] } })
    expect(badCidr.status).toBe(400)
    expect(badCidr.body.error.code).toBe('AUTH_APIKEY_INPUT_INVALID')
    const past = await h.call({ method: 'PATCH', url: `/apikeys/${id}`, headers: ana, payload: { expiresAt: 1 } })
    expect(past.status).toBe(400)
    expect(past.body.error.code).toBe('AUTH_APIKEY_EXPIRATION_INVALID')
  })

  it('rotate returns the new key once (201); the old one stops at the end of its grace', async () => {
    const { h, ana, mint } = await setup(adapter)
    const { id, key: oldKey } = await mint(ana)
    const res = await h.call({ method: 'POST', url: `/apikeys/${id}/rotate`, headers: ana, payload: { graceMs: 60_000 } })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe(id)
    expect(res.body.key).toMatch(/^mk_live_/)
    expect(res.body.key).not.toBe(oldKey)
    expect(res.body).not.toHaveProperty('hash')
    expect(res.body).not.toHaveProperty('previousHash')
    expect(typeof res.body.previousHashExpiresAt).toBe('number')
    // Without a body: no grace.
    const again = await h.call({ method: 'POST', url: `/apikeys/${id}/rotate`, headers: ana })
    expect(again.status).toBe(201)
    const tooLong = await h.call({ method: 'POST', url: `/apikeys/${id}/rotate`, headers: ana, payload: { graceMs: 31 * 86_400_000 } })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error.code).toBe('AUTH_APIKEY_INPUT_INVALID')
  })

  it('GET lists an expired key only with ?includeExpired=true', async () => {
    const { h, ana, mint, store } = await setup(adapter)
    const { id } = await mint(ana, { name: 'soon', expiresAt: Date.now() + 3_600_000 })
    await mint(ana, { name: 'live' })
    // Expire it in the store (the API refuses a past expiry).
    await store.update!(id, { expiresAt: Date.now() - 1 })
    const live = await h.call({ method: 'GET', url: '/apikeys', headers: ana })
    expect(live.body.map((k: { name: string }) => k.name)).toEqual(['live'])
    const all = await h.call({ method: 'GET', url: '/apikeys?includeExpired=true', headers: ana })
    expect(all.body.map((k: { name: string }) => k.name).sort()).toEqual(['live', 'soon'])
    const explicitFalse = await h.call({ method: 'GET', url: '/apikeys?includeExpired=false', headers: ana })
    expect(explicitFalse.body).toHaveLength(1)
    const bad = await h.call({ method: 'GET', url: '/apikeys?includeExpired=yes', headers: ana })
    expect(bad.status).toBe(400)
    // An expired key is dead: it cannot be renewed through PATCH.
    const renew = await h.call({ method: 'PATCH', url: `/apikeys/${id}`, headers: ana, payload: { expiresAt: Date.now() + 3_600_000 } })
    expect(renew.status).toBe(404)
    expect(renew.body.error.code).toBe('AUTH_APIKEY_NOT_FOUND')
  })

  it("another user's key is 404 on PATCH, rotate and DELETE", async () => {
    const { h, ana, session, mint } = await setup(adapter)
    const { id } = await mint(ana)
    const bob = await session('bob@example.com')
    for (const call of [
      { method: 'PATCH', url: `/apikeys/${id}`, payload: { name: 'mine' } },
      { method: 'POST', url: `/apikeys/${id}/rotate` },
      { method: 'DELETE', url: `/apikeys/${id}` },
    ]) {
      const res = await h.call({ ...call, headers: bob })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('AUTH_APIKEY_NOT_FOUND')
    }
  })

  it('a key can never manage keys: 403 AUTH_APIKEY_NOT_ALLOWED', async () => {
    const { h, ana, mint } = await setup(adapter)
    const { id, key } = await mint(ana)
    for (const call of [
      { method: 'PATCH', url: `/apikeys/${id}`, payload: { expiresAt: null } },
      { method: 'POST', url: `/apikeys/${id}/rotate` },
      { method: 'GET', url: '/apikeys?includeExpired=true' },
    ]) {
      const res = await h.call({ ...call, headers: { 'x-api-key': key } })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('AUTH_APIKEY_NOT_ALLOWED')
    }
  })

  it('a store without update answers 501 AUTH_APIKEY_STORE_UNSUPPORTED', async () => {
    const memory = new MemoryApiKeyStore()
    const legacy: ApiKeyStore = {
      create: (r) => memory.create(r),
      findByHash: (h) => memory.findByHash(h),
      findById: (id) => memory.findById(id),
      list: (f) => memory.list(f),
      touch: (id, at) => memory.touch(id, at),
      revoke: (id, at) => memory.revoke(id, at),
    }
    const { h, ana, mint } = await setup(adapter, legacy)
    const { id } = await mint(ana)
    for (const call of [
      { method: 'PATCH', url: `/apikeys/${id}`, payload: { name: 'x' } },
      { method: 'POST', url: `/apikeys/${id}/rotate` },
    ]) {
      const res = await h.call({ ...call, headers: ana })
      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('AUTH_APIKEY_STORE_UNSUPPORTED')
    }
  })

  it('a rotation that loses the compare-and-set answers 409 AUTH_APIKEY_CONFLICT', async () => {
    const memory = new MemoryApiKeyStore()
    // A concurrent rotation always wins in between: every compare-and-set fails.
    const racing: ApiKeyStore = Object.assign(Object.create(memory) as MemoryApiKeyStore, {
      update: async (...args: Parameters<NonNullable<ApiKeyStore['update']>>) => (args[2]?.ifHash ? null : memory.update(...args)),
    })
    const { h, ana, mint } = await setup(adapter, racing)
    const { id } = await mint(ana)
    const res = await h.call({ method: 'POST', url: `/apikeys/${id}/rotate`, headers: ana })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('AUTH_APIKEY_CONFLICT')
  })

  it('POST /apikeys accepts an allowlist and metadata; service keys cannot be minted here', async () => {
    const { h, ana } = await setup(adapter)
    const res = await h.call({
      method: 'POST',
      url: '/apikeys',
      headers: ana,
      payload: { name: 'ci', allowedIps: ['192.0.2.0/24'], meta: { ticket: 'OPS-9' }, serviceId: 'sneaky' },
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ allowedIps: ['192.0.2.0/24'], meta: { ticket: 'OPS-9' } })
    expect(res.body.serviceId).toBeUndefined()
    expect(typeof res.body.userId).toBe('string')
  })

  it('a programmatic service key is invisible to the self-service routes', async () => {
    const { h, ana, store } = await setup(adapter)
    const { record } = await new ApiKeys({ store }).issue({ name: 'erp', serviceId: 'erp-sync' })
    const list = await h.call({ method: 'GET', url: '/apikeys', headers: ana })
    expect(list.body).toEqual([])
    const res = await h.call({ method: 'POST', url: `/apikeys/${record.id}/rotate`, headers: ana })
    expect(res.status).toBe(404)
  })
})
