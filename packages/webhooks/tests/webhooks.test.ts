import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import {
  MemoryWebhookStore,
  matchesEvent,
  signPayload,
  verifySignature,
  WebhookDeliverer,
  WebhookManager,
  WEBHOOKS,
  webhooksPlugin,
} from '../src/index.js'

const okResponse = (status = 200) => ({ ok: status >= 200 && status < 300, status }) as unknown as Response
const noSleep = async () => {}
// Resolve any (fake) test hostname to a public IP so the SSRF guard passes for
// delivery-mechanics tests without real DNS. SSRF blocking is covered separately.
const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] }

describe('signing', () => {
  it('signs and verifies, rejecting tampering and stale timestamps', () => {
    const header = signPayload('{"a":1}', 'whsec', 1000)
    expect(verifySignature(header, '{"a":1}', 'whsec', 300, 1000)).toBe(true)
    expect(verifySignature(header, '{"a":2}', 'whsec', 300, 1000)).toBe(false) // tampered body
    expect(verifySignature(header, '{"a":1}', 'other', 300, 1000)).toBe(false) // wrong secret
    expect(verifySignature(header, '{"a":1}', 'whsec', 300, 5000)).toBe(false) // stale
  })
})

describe('matchesEvent + store', () => {
  it('matches exact, prefix and wildcard patterns', () => {
    expect(matchesEvent(['invoice.paid'], 'invoice.paid')).toBe(true)
    expect(matchesEvent(['invoice.*'], 'invoice.paid')).toBe(true)
    expect(matchesEvent(['*'], 'anything')).toBe(true)
    expect(matchesEvent(['invoice.*'], 'user.created')).toBe(false)
  })

  it('forEvent filters by pattern and tenant', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ url: 'https://a', events: ['invoice.*'], tenantId: 'acme' })
    await store.add({ url: 'https://b', events: ['invoice.paid'] }) // all tenants
    await store.add({ url: 'https://c', events: ['user.*'], tenantId: 'acme' })

    const matched = await store.forEvent('invoice.paid', 'acme')
    expect(matched.map((e) => e.url).sort()).toEqual(['https://a', 'https://b'])
    // a different tenant only gets the tenant-agnostic one
    expect((await store.forEvent('invoice.paid', 'globex')).map((e) => e.url)).toEqual(['https://b'])
  })

  it('remove is tenant-scoped when a tenantId is given (no cross-tenant delete)', async () => {
    const store = new MemoryWebhookStore()
    const ep = await store.add({ url: 'https://a', events: ['*'], tenantId: 'acme' })
    await store.remove(ep.id, 'globex') // wrong tenant → no-op
    expect(await store.list()).toHaveLength(1)
    await store.remove(ep.id, 'acme') // owning tenant → removed
    expect(await store.list()).toHaveLength(0)
  })
})

describe('WebhookDeliverer', () => {
  const endpoint = { id: 'ep1', url: 'https://hook', events: ['*'] }

  it('delivers on first success', async () => {
    const fetchImpl = vi.fn((_url: string | URL, _init?: RequestInit) => Promise.resolve(okResponse(200)))
    const deliverer = new WebhookDeliverer({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      now: () => 1000,
      secret: 's',
      ssrf: publicDns,
    })
    const result = await deliverer.deliver(endpoint, 'invoice.paid', { amount: 10 })
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    // signed
    const init = fetchImpl.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>)['x-basalt-signature']).toContain('t=1000')
  })

  it('retries 5xx with backoff then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => okResponse(n++ < 2 ? 503 : 200))
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep, maxRetries: 3, ssrf: publicDns })
    const result = await deliverer.deliver(endpoint, 'e', {})
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(3)
  })

  it('does not retry 4xx', async () => {
    const fetchImpl = vi.fn(async () => okResponse(400))
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep, maxRetries: 3, ssrf: publicDns })
    const result = await deliverer.deliver(endpoint, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries on persistent failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep, maxRetries: 2, ssrf: publicDns })
    const result = await deliverer.deliver(endpoint, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(3) // 1 + 2 retries
    expect(result.error).toContain('ECONNREFUSED')
  })
})

describe('WebhookDeliverer — SSRF guard', () => {
  it('refuses a URL whose host is a private/metadata IP, without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200))
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep })
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/']) {
      const result = await deliverer.deliver({ id: 'x', url, events: ['*'] }, 'e', {})
      expect(result.ok).toBe(false)
      expect(result.attempts).toBe(0)
      expect(result.error).toMatch(/private or reserved/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200))
    const deliverer = new WebhookDeliverer({
      fetchImpl,
      sleep: noSleep,
      ssrf: { lookup: async () => [{ address: '10.1.2.3' }] }, // internal rebind
    })
    const result = await deliverer.deliver({ id: 'x', url: 'https://evil.example', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/resolves to a private address/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a non-http(s) scheme', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200))
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep })
    const result = await deliverer.deliver({ id: 'x', url: 'file:///etc/passwd', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/scheme/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allowPrivateHosts opts out for trusted internal delivery', async () => {
    const fetchImpl = vi.fn(async () => okResponse(200))
    const deliverer = new WebhookDeliverer({ fetchImpl, sleep: noSleep, ssrf: { allowPrivateHosts: true } })
    const result = await deliverer.deliver({ id: 'x', url: 'http://10.0.0.5/hook', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not follow a redirect (redirect: manual, refused)', async () => {
    const fetchImpl = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: false, status: 0, type: 'opaqueredirect' } as unknown as Response),
    )
    const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep, ssrf: publicDns })
    const result = await deliverer.deliver({ id: 'x', url: 'https://hook', events: ['*'] }, 'e', {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe('redirect refused')
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe('manual')
  })
})

describe('WebhookManager.dispatch', () => {
  it('delivers to every matching endpoint', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'a', url: 'https://a', events: ['invoice.*'] })
    await store.add({ id: 'b', url: 'https://b', events: ['user.*'] })
    const fetchImpl = vi.fn(async () => okResponse(200))
    const manager = new WebhookManager(store, new WebhookDeliverer({ fetchImpl, sleep: noSleep, ssrf: publicDns }))

    const results = await manager.dispatch('invoice.paid', { amount: 1 })
    expect(results).toHaveLength(1)
    expect(results[0]!.endpointId).toBe('a')
  })
})

describe('webhooksPlugin', () => {
  it('auto-dispatches subscribed domain events, tenant-scoped', async () => {
    const store = new MemoryWebhookStore()
    const delivered: string[] = []
    const fakeDeliverer = {
      deliver: async (ep: { id: string }, event: string) => {
        delivered.push(`${ep.id}:${event}`)
        return { endpointId: ep.id, ok: true, attempts: 1 }
      },
    } as unknown as WebhookDeliverer

    const app = await createApp({
      plugins: [
        eventsPlugin(),
        webhooksPlugin({ store, deliverer: fakeDeliverer, events: ['invoice.*'] }),
      ],
    }).boot()

    await app.container.get(WEBHOOKS).register({ id: 'ep', url: 'https://hook', events: ['invoice.*'] })

    const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
    await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
    await new Promise((resolve) => setTimeout(resolve, 0)) // flush fire-and-forget

    expect(delivered).toContain('ep:invoice.paid')
    await app.shutdown()
  })
})
