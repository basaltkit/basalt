import { afterEach, describe, expect, it } from 'vitest'
import { createApp, ctx, definePlugin } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import {
  ApiKeyInvalidError,
  ApiKeyOptionsError,
  ApiKeys,
  DEFAULT_API_KEY_TOUCH_EVERY_MS,
  MemoryApiKeyStore,
  MemoryUserSource,
  apiKeysPlugin,
  authPlugin,
  type ApiKeysPluginOptions,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * BK-083 phase 1: an API key presented to a machine gateway.
 *  (a) `rejectInvalid` turns a dead key into 401 + RFC 6750 challenge, on every adapter;
 *  (b) `lastUsedAt` writes are throttled by `touchEveryMs`;
 *  (d) the rejection hook carries the display prefix and IP, never the secret.
 */

const secret = 'test-secret-test-secret-test-secret'

const routes = [
  route({ method: 'GET', url: '/public', handler: () => ({ key: ctx().apiKey?.id ?? null }) }),
  route({ method: 'GET', url: '/orders', meta: { scopes: ['orders:read'] }, handler: () => ({ ok: true }) }),
  route({ method: 'GET', url: '/me', meta: { auth: true }, handler: () => ({ ok: true }) }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

interface Rejection {
  reason: string
  prefix?: string
  ip?: string
}

async function setup(adapter: (typeof availableAdapters)[number], keyOptions: ApiKeysPluginOptions = {}) {
  const users = new MemoryUserSource()
  const store = new MemoryApiKeyStore()
  const keys = new ApiKeys({ store })
  const rejections: Rejection[] = []
  const recorder = definePlugin({
    name: 'test:rejections',
    register({ hooks }) {
      hooks.on('auth:apikey_rejected', (payload) => {
        rejections.push(payload as Rejection)
      })
    },
  })
  harness = await boot(
    adapter,
    [
      recorder,
      authPlugin({ users, secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false }),
      apiKeysPlugin({ users, store, ...keyOptions }),
    ],
    routes,
  )
  return { keys, rejections, h: harness }
}

describe.each(availableAdapters)('%s: apiKeysPlugin rejectInvalid (BK-083 a)', (adapter) => {
  it('default: an invalid key continues as anonymous (public route served, guards answer)', async () => {
    const { h, rejections } = await setup(adapter)
    const dead = 'mk_live_deadbeefdeadbeefdeadbeefdeadbeef'
    const pub = await h.call({ method: 'GET', url: '/public', headers: { 'x-api-key': dead } })
    expect(pub.status).toBe(200)
    expect(pub.body).toEqual({ key: null })
    const scoped = await h.call({ method: 'GET', url: '/orders', headers: { authorization: `Bearer ${dead}` } })
    expect(scoped.status).toBe(403)
    expect(scoped.body.error.code).toBe('AUTH_SCOPE_REQUIRED')
    expect(scoped.headers['www-authenticate']).toBeUndefined()
    expect(rejections).toHaveLength(2)
  })

  it('rejectInvalid: 401 AUTH_APIKEY_INVALID with WWW-Authenticate, before any guard', async () => {
    const { h } = await setup(adapter, { rejectInvalid: true })
    for (const url of ['/public', '/orders', '/me']) {
      const res = await h.call({ method: 'GET', url, headers: { authorization: 'Bearer mk_live_deadbeefdeadbeefdeadbeefdeadbeef' } })
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('AUTH_APIKEY_INVALID')
      expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"')
    }
  })

  it('rejectInvalid: a revoked key is refused; no key at all is still anonymous', async () => {
    const { h, keys } = await setup(adapter, { rejectInvalid: true })
    const { record, key } = await keys.issue({ name: 'erp', scopes: ['orders:read'] })
    expect((await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })).status).toBe(200)
    await keys.revoke(record.id)
    const revoked = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })
    expect(revoked.status).toBe(401)
    expect(revoked.body.error.code).toBe('AUTH_APIKEY_INVALID')
    const none = await h.call({ method: 'GET', url: '/public' })
    expect(none.status).toBe(200)
  })

  it('the rejection hook carries the display prefix and IP, never the key', async () => {
    const { h, rejections } = await setup(adapter, { rejectInvalid: true })
    const dead = 'mk_live_abcdefSECRETSECRETSECRETSECRET'
    await h.call({ method: 'GET', url: '/public', headers: { 'x-api-key': dead } })
    await h.call({ method: 'GET', url: '/public', headers: { 'x-api-key': 'sk_other_vendor_secret' } })
    expect(rejections[0]).toMatchObject({ reason: 'invalid', prefix: 'mk_live_abcdef' })
    expect(rejections[1]?.prefix).toBeUndefined()
    expect(JSON.stringify(rejections)).not.toContain('SECRET')
    expect(JSON.stringify(rejections)).not.toContain('sk_other_vendor_secret')
    // fastify inject and express over loopback both report an address; hono's
    // in-process request() has no socket, so the IP is simply absent there.
    if (adapter !== 'hono') expect(typeof rejections[0]?.ip).toBe('string')
  })
})

describe('ApiKeys touchEveryMs (BK-083 b)', () => {
  const counting = () => {
    const store = new MemoryApiKeyStore()
    let touches = 0
    const touch = store.touch.bind(store)
    store.touch = async (id, at) => {
      touches++
      await touch(id, at)
    }
    return { store, count: () => touches }
  }

  it('writes lastUsedAt at most once per window per key', async () => {
    let now = 1_000_000
    const { store, count } = counting()
    const keys = new ApiKeys({ store, now: () => now })
    const { key } = await keys.issue({ name: 'erp' })
    for (let i = 0; i < 50; i++) {
      expect(await keys.verify(key)).not.toBeNull()
      now += 1_000
    }
    // 50 verifications over 50 s: the first one touches, the rest fall in the window.
    expect(count()).toBe(1)
    now += DEFAULT_API_KEY_TOUCH_EVERY_MS
    await keys.verify(key)
    expect(count()).toBe(2)
    expect((await keys.get((await keys.list({}))[0]!.id))?.lastUsedAt).toBe(now)
  })

  it('touchEveryMs: 0 restores a write per verification', async () => {
    const { store, count } = counting()
    const keys = new ApiKeys({ store, touchEveryMs: 0 })
    const { key } = await keys.issue({ name: 'erp' })
    await keys.verify(key)
    await keys.verify(key)
    await keys.verify(key)
    expect(count()).toBe(3)
  })

  it('refuses a negative or non-finite window at construction', () => {
    expect(() => new ApiKeys({ touchEveryMs: -1 })).toThrow(ApiKeyOptionsError)
    expect(() => new ApiKeys({ touchEveryMs: Number.NaN })).toThrow(ApiKeyOptionsError)
  })

  it('apiKeysPlugin refuses an invalid touchEveryMs at boot, not on the first request', async () => {
    await expect(createApp({ plugins: [apiKeysPlugin({ touchEveryMs: -5 })] }).boot()).rejects.toThrow(ApiKeyOptionsError)
  })

  it('ApiKeyInvalidError is a 401 with a stable code', () => {
    const error = new ApiKeyInvalidError()
    expect(error.status).toBe(401)
    expect(error.code).toBe('AUTH_APIKEY_INVALID')
  })
})
