import { describe, expect, it, vi } from 'vitest'
import { MemoryOutboxStore, Outbox } from '@basaltkit/events'
import { MemoryWebhookStore, WebhookDeliverer, WebhookManager, webhookOutboxDispatch } from '../src/index.js'

const SECRET = 'whsec_test_0123456789abcdef'
const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] }

/**
 * SECURITY INVARIANT (availability, F68): on the durable webhook path, one
 * tenant's hanging endpoint — flooding the outbox faster than it can time out —
 * cannot starve another tenant's deliveries, and the relay keeps ticking.
 */
describe('webhook outbox: a hanging tenant endpoint cannot starve other tenants', () => {
  it('delivers tenant B within the first flush behind a larger-than-batch backlog of tenant A', async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'a', url: 'https://a.example/hook', events: ['*'], tenantId: 'tenant-a', secret: `${SECRET}_a` })
    await store.add({ id: 'b', url: 'https://b.example/hook', events: ['*'], tenantId: 'tenant-b', secret: `${SECRET}_b` })
    // A's receiver accepts the connection and never answers (ignores abort too).
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).startsWith('https://a.') ? new Promise<Response>(() => {}) : ({ ok: true, status: 200 } as Response),
    )
    const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns })
    const dispatch = webhookOutboxDispatch(new WebhookManager(store, deliverer))

    let clock = 0
    const outbox = new Outbox(new MemoryOutboxStore(), { now: () => clock, dispatchTimeoutMs: 20 })
    for (let i = 0; i < 120; i++) {
      clock += 1
      await outbox.enqueue('order.created', { i }, 'tenant-a')
    }
    clock += 1
    await outbox.enqueue('order.created', { id: 'b1' }, 'tenant-b')

    const result = await outbox.flush(dispatch, 50)
    expect(result.published).toBe(1)
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('https://b.example/hook')
    // A never holds more than its share of in-flight deliveries (ceil(8 / 2)).
    expect(urls.filter((u) => u.startsWith('https://a.')).length).toBeLessThanOrEqual(4)
  })
})

/**
 * SECURITY INVARIANT: a store read without a tenant is fail-closed — it returns
 * tenant-agnostic endpoints only, never every tenant's, however the "no tenant"
 * is spelled. System fan-out is the explicit `allTenants` dispatch.
 */
describe('MemoryWebhookStore.forEvent fails closed without a tenant', () => {
  const seeded = async () => {
    const store = new MemoryWebhookStore()
    await store.add({ id: 'global', url: 'https://g', events: ['*'] })
    await store.add({ id: 'acme', url: 'https://a', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'off', url: 'https://o', events: ['*'], tenantId: 'globex', active: false })
    return store
  }

  it.each([undefined, null, ''])('forEvent(event, %j) returns only tenant-agnostic endpoints', async (tenant) => {
    const store = await seeded()
    expect((await store.forEvent('invoice.paid', tenant as unknown as string)).map((e) => e.id)).toEqual(['global'])
  })

  it('an explicit allTenants dispatch still reaches every tenant, skipping inactive endpoints', async () => {
    const store = await seeded()
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns, secret: SECRET, allowSharedSecret: true })
    await new WebhookManager(store, deliverer).dispatch('invoice.paid', {}, { allTenants: true })
    expect(fetchImpl.mock.calls.map((c) => String((c as unknown[])[0])).sort()).toEqual(['https://a', 'https://g'])
  })
})
