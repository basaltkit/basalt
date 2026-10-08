import { afterEach, describe, expect, it } from 'vitest'
import { createApp, ctx, definePlugin, ensureMetadata } from '@basaltkit/core'
import { route, runRoute, type HttpReply, type HttpRequest, type RequestEnricher, type RouteGuard } from '@basaltkit/http'
import {
  ApiKeyInputError,
  ApiKeyIpNotAllowedError,
  ApiKeys,
  API_KEY_ALLOWED_IPS_MAX,
  MemoryApiKeyStore,
  apiKeysPlugin,
} from '../src/index.js'
import { ipAllowed, normalizeAllowedIps, normalizeRequestIp } from '../src/ip-allowlist.js'
import { availableAdapters, boot, honoModule, type Harness } from './helpers/adapters.js'

/** BK-083 (f): a per-key IP allowlist, enforced in the neutral enricher on every adapter. */

describe('allowlist validation', () => {
  it('canonicalises addresses and networks', () => {
    expect(
      normalizeAllowedIps(['10.0.0.0/8', '192.0.2.7', '2001:DB8::/32', '::ffff:198.51.100.0/120', '::FFFF:203.0.113.9', '10.0.0.0/8']),
    ).toEqual(['10.0.0.0/8', '192.0.2.7', '2001:db8::/32', '198.51.100.0/24', '203.0.113.9'])
    expect(normalizeAllowedIps(['0.0.0.0/0', '::/0'])).toEqual(['0.0.0.0/0', '::/0'])
  })

  it.each([
    ['10.0.0.5/8', 'host bits set'],
    ['2001:db8::1/32', 'host bits set'],
    ['10.0.0.0/33', 'prefix too long'],
    ['::/129', 'prefix too long'],
    ['10.0.0.0/', 'empty prefix'],
    ['10.0.0.0/-1', 'negative prefix'],
    ['fe80::1%eth0', 'zone id'],
    ['example.com', 'not an address'],
    ['10.0.0', 'not an address'],
    ['', 'empty'],
  ])('refuses %s (%s)', (entry) => {
    expect(() => normalizeAllowedIps([entry])).toThrow()
  })

  it(`holds at most ${API_KEY_ALLOWED_IPS_MAX} entries`, async () => {
    const entries = Array.from({ length: API_KEY_ALLOWED_IPS_MAX + 1 }, (_, i) => `192.0.2.${i}`)
    expect(() => normalizeAllowedIps(entries)).toThrow()
    const keys = new ApiKeys()
    await expect(keys.issue({ name: 'x', allowedIps: entries })).rejects.toBeInstanceOf(ApiKeyInputError)
    await expect(keys.issue({ name: 'x', allowedIps: ['10.0.0.5/8'] })).rejects.toThrow(/not a network address/)
    expect((await keys.issue({ name: 'x', allowedIps: entries.slice(0, API_KEY_ALLOWED_IPS_MAX) })).record.allowedIps).toHaveLength(
      API_KEY_ALLOWED_IPS_MAX,
    )
  })
})

describe('allowlist check', () => {
  it('matches v4, IPv4-mapped v6, v6 networks and single addresses', () => {
    expect(ipAllowed(['127.0.0.0/8'], '127.0.0.1')).toBe(true)
    expect(ipAllowed(['127.0.0.0/8'], '::ffff:127.0.0.1')).toBe(true)
    expect(ipAllowed(['127.0.0.0/8'], '10.0.0.1')).toBe(false)
    expect(ipAllowed(['2001:db8:1:2::/64'], '2001:db8:1:2:abcd::1')).toBe(true)
    expect(ipAllowed(['2001:db8:1:2::/64'], '2001:db8:1:3::1')).toBe(false)
    expect(ipAllowed(['192.0.2.7'], '192.0.2.7')).toBe(true)
    expect(ipAllowed(['192.0.2.7'], '192.0.2.8')).toBe(false)
  })

  it('normalises brackets and zone ids on the request address', () => {
    expect(normalizeRequestIp('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeRequestIp('fe80::1%eth0')).toBe('fe80::1')
    expect(ipAllowed(['fe80::/64'], 'fe80::1%eth0')).toBe(true)
    expect(normalizeRequestIp('::FFFF:10.1.2.3')).toBe('10.1.2.3')
  })

  it('fails closed: no address, or an unparseable one, is refused when a list exists', () => {
    expect(ipAllowed(['0.0.0.0/0'], undefined)).toBe(false)
    expect(ipAllowed(['0.0.0.0/0'], '')).toBe(false)
    expect(ipAllowed(['0.0.0.0/0'], 'not-an-ip')).toBe(false)
    // No list (or an empty one): any caller, even without an address.
    expect(ipAllowed(undefined, undefined)).toBe(true)
    expect(ipAllowed([], undefined)).toBe(true)
  })

  it('authenticate: ip_not_allowed carries the record and never touches lastUsedAt', async () => {
    const store = new MemoryApiKeyStore()
    const keys = new ApiKeys({ store, touchEveryMs: 0 })
    const { record, key } = await keys.issue({ name: 'x', allowedIps: ['10.0.0.0/8'] })
    const refused = await keys.authenticate(key, { ip: '192.0.2.1' })
    expect(refused).toMatchObject({ ok: false, reason: 'ip_not_allowed', record: { id: record.id } })
    expect((await store.findById(record.id))?.lastUsedAt).toBeUndefined()
    expect(await keys.verify(key)).toBeNull() // no ip at all
    expect((await keys.verify(key, { ip: '10.9.8.7' }))?.id).toBe(record.id)
    // A dead key is `invalid` before any address check.
    await keys.revoke(record.id)
    expect(await keys.authenticate(key, { ip: '192.0.2.1' })).toEqual({ ok: false, reason: 'invalid' })
  })
})

const routes = [
  route({ method: 'GET', url: '/orders', meta: { scopes: ['orders:read'] }, handler: () => ({ key: ctx().apiKey?.id ?? null }) }),
  route({ method: 'GET', url: '/public', handler: () => ({ key: ctx().apiKey?.id ?? null }) }),
]

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

interface Rejection {
  id?: string
  reason: string
  ip?: string
}

async function setup(adapter: (typeof availableAdapters)[number], hono: Record<string, unknown> = { getClientIp: () => '127.0.0.1' }) {
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
  harness = await boot(adapter, [recorder, apiKeysPlugin({ store })], routes, { hono })
  return { keys, store, rejections, h: harness }
}

describe.each(availableAdapters)('%s: per-key IP allowlist (BK-083 f)', (adapter) => {
  it('a key used from inside its allowlist is served', async () => {
    const { keys, h } = await setup(adapter)
    const { record, key } = await keys.issue({ name: 'ci', scopes: ['orders:read'], allowedIps: ['127.0.0.0/8', '::1'] })
    const res = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ key: record.id })
  })

  it('a key used from outside its allowlist is 403 AUTH_APIKEY_IP_NOT_ALLOWED, even on a public route', async () => {
    const { keys, store, h, rejections } = await setup(adapter)
    const { record, key } = await keys.issue({ name: 'ci', scopes: ['orders:read'], allowedIps: ['10.0.0.0/8'] })
    for (const url of ['/orders', '/public']) {
      const res = await h.call({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('AUTH_APIKEY_IP_NOT_ALLOWED')
    }
    expect(rejections).toHaveLength(2)
    expect(rejections[0]).toMatchObject({ id: record.id, reason: 'ip_not_allowed' })
    expect(JSON.stringify(rejections)).not.toContain(key)
    expect((await store.findById(record.id))?.lastUsedAt).toBeUndefined()
  })

  it('a key without an allowlist is unaffected', async () => {
    const { keys, h } = await setup(adapter)
    const { key } = await keys.issue({ name: 'ci', scopes: ['orders:read'] })
    expect((await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })).status).toBe(200)
  })
})

describe.skipIf(!honoModule)('hono without a client address (runtime caveat)', () => {
  it('an allowlisted key fails closed (403) when the runtime reports no address', async () => {
    const { keys, h } = await setup('hono', {})
    const { key } = await keys.issue({ name: 'ci', scopes: ['orders:read'], allowedIps: ['0.0.0.0/0', '::/0'] })
    const res = await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('AUTH_APIKEY_IP_NOT_ALLOWED')
  })

  it('a zone-scoped address from getClientIp is normalised before the check', async () => {
    const { keys, h } = await setup('hono', { getClientIp: () => 'fe80::1%eth0' })
    const { key } = await keys.issue({ name: 'ci', scopes: ['orders:read'], allowedIps: ['fe80::/64'] })
    expect((await h.call({ method: 'GET', url: '/orders', headers: { 'x-api-key': key } })).status).toBe(200)
  })
})

describe('a hand-built pipeline with no request.ip', () => {
  const reply = (): HttpReply => {
    let status = 200
    const self = {
      sent: false,
      get statusCode() {
        return status
      },
      raw: null,
      code(next: number) {
        status = next
        return self
      },
      header() {
        return self
      },
      send() {
        return self
      },
    }
    return self as unknown as HttpReply
  }

  it('refuses an allowlisted key with ApiKeyIpNotAllowedError', async () => {
    const store = new MemoryApiKeyStore()
    const app = await createApp({ plugins: [apiKeysPlugin({ store })] }).boot()
    const metadata = ensureMetadata(app.container)
    const { key } = await new ApiKeys({ store }).issue({ name: 'ci', scopes: ['*'], allowedIps: ['127.0.0.1'] })
    const request: HttpRequest = { method: 'GET', url: '/public', headers: { 'x-api-key': key }, params: {}, query: {}, body: undefined, raw: null }
    await expect(
      runRoute(routes[1]!, request, reply(), {
        container: app.container,
        enrichers: metadata.get<RequestEnricher>('http:enrichers'),
        guards: metadata.get<RouteGuard>('http:guards'),
      }),
    ).rejects.toBeInstanceOf(ApiKeyIpNotAllowedError)
    await app.shutdown()
  })
})
