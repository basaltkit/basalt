import { describe, expect, it } from 'vitest'
import {
  isPrivateIp,
  MemoryWebhookStore,
  WebhookDeliverer,
  WebhookEndpointIdInUseError,
  WebhookEndpointInvalidError,
  WebhookManager,
} from '../src/index.js'

/**
 * Framework audit residuals (FA-070 D8 and the SSRF/registration follow-ups).
 * Each case was reproduced against the previous release first.
 */
const SECRET = 'whsec_0123456789abcdef'

describe('MemoryWebhookStore · an id never crosses scopes', () => {
  it('add() refuses an id held by another tenant, like the SQL stores', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'hook', url: 'https://acme.example/', events: ['*'], tenantId: 'acme', secret: SECRET })
    await expect(
      store.add({ id: 'hook', url: 'https://evil.example/', events: ['*'], tenantId: 'globex', secret: SECRET }),
    ).rejects.toBeInstanceOf(WebhookEndpointIdInUseError)
    expect((await store.list('acme'))[0]?.url).toBe('https://acme.example/')
  })

  it('add() refuses a tenant id over a global one and vice versa', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'g', url: 'https://ops.example/', events: ['*'] })
    await store.add({ id: 't', url: 'https://acme.example/', events: ['*'], tenantId: 'acme' })
    await expect(store.add({ id: 'g', url: 'https://evil.example/', events: ['*'], tenantId: 'acme' })).rejects.toBeInstanceOf(
      WebhookEndpointIdInUseError,
    )
    await expect(store.add({ id: 't', url: 'https://evil.example/', events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointIdInUseError)
  })

  it('add() still replaces within the same scope', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'a', url: 'https://one.example/', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'a', url: 'https://two.example/', events: ['*'], tenantId: 'acme' })
    expect((await store.list('acme')).map((e) => e.url)).toEqual(['https://two.example/'])
  })

  it('two concurrent register() calls with the same id from two tenants: one wins, the other is refused', async () => {
    const store = new MemoryWebhookStore()
    const manager = new WebhookManager(store, new WebhookDeliverer())
    const results = await Promise.allSettled([
      manager.register({ id: 'race', url: 'https://acme.example/', events: ['*'], tenantId: 'acme' }),
      manager.register({ id: 'race', url: 'https://evil.example/', events: ['*'], tenantId: 'globex' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(WebhookEndpointIdInUseError)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.url).toBe('https://acme.example/')
  })

  it('the manager refuses a cross-scope id with the same typed error', async () => {
    const manager = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer())
    await manager.register({ id: 'x', url: 'https://acme.example/', events: ['*'], tenantId: 'acme' })
    await expect(
      manager.register({ id: 'x', url: 'https://evil.example/', events: ['*'], tenantId: 'globex' }),
    ).rejects.toBeInstanceOf(WebhookEndpointIdInUseError)
  })
})

describe('isPrivateIp · documentation, benchmark and special-purpose ranges', () => {
  it.each([
    '192.0.2.1', // TEST-NET-1
    '198.51.100.7', // TEST-NET-2
    '203.0.113.200', // TEST-NET-3
    '192.88.99.1', // deprecated 6to4 relay anycast
    '198.18.0.1', // benchmarking
    '198.19.255.255',
    '240.0.0.1', // reserved
    '100.64.0.1', // CGNAT
    '64:ff9b::c000:201', // NAT64 → 192.0.2.1
    '64:ff9b::a00:1', // NAT64 → 10.0.0.1
    '2002:c000:0201::1', // 6to4 → 192.0.2.1
    '2002:0a00:0001::1', // 6to4 → 10.0.0.1
    '::ffff:203.0.113.1', // mapped TEST-NET-3
    '3fff::1', // IPv6 documentation (RFC 9637)
    '2001:db8::1', // IPv6 documentation
  ])('%s is blocked', (ip) => {
    expect(isPrivateIp(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '192.0.3.1', '198.51.101.1', '203.0.114.1', '192.88.100.1', '2606:4700::1111'])('%s stays public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false)
  })
})

describe('WebhookManager.register() validates the endpoint up front', () => {
  const manager = () => new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET }))

  it.each(['not a url', '', '/relative/path', 'ftp://files.example/', 'javascript:alert(1)', 'file:///etc/passwd'])(
    'refuses url %j',
    async (url) => {
      await expect(manager().register({ url, events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    },
  )

  it('refuses a non-string url', async () => {
    await expect(manager().register({ url: 42 as never, events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
  })

  it.each(['', 'short', 'x'.repeat(15)])('refuses a secret shorter than the minimum (%j)', async (secret) => {
    await expect(manager().register({ url: 'https://hook.example/', events: ['*'], secret })).rejects.toBeInstanceOf(
      WebhookEndpointInvalidError,
    )
  })

  it('refuses events that are not a non-empty array of non-empty strings', async () => {
    await expect(manager().register({ url: 'https://hook.example/', events: [] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(manager().register({ url: 'https://hook.example/', events: [''] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
  })

  it('honours the deliverer scheme allowlist', async () => {
    const httpsOnly = new WebhookManager(new MemoryWebhookStore(), new WebhookDeliverer({ secret: SECRET, ssrf: { allowedSchemes: ['https:'] } }))
    await expect(httpsOnly.register({ url: 'http://hook.example/', events: ['*'] })).rejects.toBeInstanceOf(WebhookEndpointInvalidError)
    await expect(httpsOnly.register({ url: 'https://hook.example/', events: ['*'] })).resolves.toMatchObject({ url: 'https://hook.example/' })
  })

  it('nothing is stored when validation fails', async () => {
    const store = new MemoryWebhookStore()
    const m = new WebhookManager(store, new WebhookDeliverer({ secret: SECRET }))
    await m.register({ url: 'nope', events: ['*'] }).catch(() => {})
    expect(await store.list()).toEqual([])
  })
})
