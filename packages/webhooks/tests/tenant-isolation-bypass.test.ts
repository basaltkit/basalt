import { describe, expect, it, vi } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { MemoryOutboxStore, Outbox } from '@basaltkit/events'
import {
  MemoryWebhookStore,
  WebhookDeliverer,
  WebhookManager,
  WebhookTenantRequiredError,
  webhookOutboxDispatch,
  type WebhookEndpoint,
  type WebhookStore,
} from '../src/index.js'

const SECRET = 'whsec_test_0123456789abcdef'
const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] }
const okResponse = () => ({ ok: true, status: 200 }) as unknown as Response
const asTenant = <T>(id: string, fn: () => T): T => runWithContext({ tenant: { id } } as never, fn)

/**
 * A store that behaves like the SQL-backed ones (webhooks-prisma / -sqlite):
 * a `null` tenant column is read back as "no tenant", i.e. a GLOBAL endpoint.
 */
class NullableColumnStore implements WebhookStore {
  readonly inner = new MemoryWebhookStore()
  private norm = (e: WebhookEndpoint): WebhookEndpoint => {
    const { tenantId, ...rest } = e
    return tenantId == null ? rest : { ...rest, tenantId }
  }
  async forEvent(event: string, tenantId?: string) {
    return (await this.inner.list()).map(this.norm).filter(
      (e) => (e.active ?? true) && e.events.some((p) => p === '*' || event.startsWith(p.replace(/\*$/, ''))) &&
        (tenantId === undefined || e.tenantId === undefined || e.tenantId === tenantId),
    )
  }
  add(e: Omit<WebhookEndpoint, 'id'> & { id?: string }) {
    return this.inner.add(e)
  }
  remove(id: string, tenantId?: string) {
    return this.inner.remove(id, tenantId)
  }
  async list(tenantId?: string) {
    return (await this.inner.list()).map(this.norm).filter((e) => tenantId === undefined || e.tenantId === tenantId)
  }
}

function deliverer() {
  const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse())
  const d = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns })
  const urls = () => fetchImpl.mock.calls.map((c) => String(c[0]))
  return { d, urls }
}

describe('webhooks tenant isolation — bypass attempts', () => {
  it('register with a null/empty tenantId (JSON type confusion) cannot create an unscoped endpoint when tenancy is active', async () => {
    const store = new NullableColumnStore()
    const { d } = deliverer()
    const manager = new WebhookManager(store, d, { tenancyActive: () => true })
    for (const bad of [null, '', 0, false, ['acme'], { id: 'acme' }] as unknown[]) {
      await expect(
        manager.register({ url: 'https://evil.example/h', events: ['*'], tenantId: bad as string }),
      ).rejects.toBeInstanceOf(WebhookTenantRequiredError)
    }
    expect(await store.list()).toEqual([])
  })

  it('a null tenantId never turns into a global endpoint that receives another tenant\'s events', async () => {
    const store = new NullableColumnStore()
    const { d, urls } = deliverer()
    const manager = new WebhookManager(store, d, { tenancyActive: () => true })
    await manager.register({ url: 'https://evil.example/h', events: ['*'], tenantId: null as unknown as string }).catch(() => {})
    await manager.dispatch('invoice.paid', { secret: 'acme data' }, 'acme')
    expect(urls()).toEqual([])
  })

  it('list/unregister with a null or empty tenantId are refused like a missing one', async () => {
    const store = new MemoryWebhookStore()
    const { d } = deliverer()
    const manager = new WebhookManager(store, d, { tenancyActive: () => true })
    await expect(manager.list(null as unknown as string)).rejects.toBeInstanceOf(WebhookTenantRequiredError)
    await expect(manager.list('')).rejects.toBeInstanceOf(WebhookTenantRequiredError)
    await expect(manager.unregister('x', { tenantId: null as unknown as string })).rejects.toBeInstanceOf(WebhookTenantRequiredError)
    await expect(manager.unregister('x', { tenantId: '' })).rejects.toBeInstanceOf(WebhookTenantRequiredError)
  })

  it('a tenant cannot overwrite another tenant\'s endpoint by re-using its id on register', async () => {
    const store = new MemoryWebhookStore()
    const { d, urls } = deliverer()
    const manager = new WebhookManager(store, d, { tenancyActive: () => true })
    await store.add({ id: 'acme-hook', url: 'https://acme.example/hook', events: ['invoice.*'], tenantId: 'acme', secret: `${SECRET}_a` })
    await expect(
      asTenant('globex', () => manager.register({ id: 'acme-hook', url: 'https://evil.example/h', events: ['invoice.*'] })),
    ).rejects.toThrow()
    const [acme] = await store.list('acme')
    expect(acme?.url).toBe('https://acme.example/hook')
    await manager.dispatch('invoice.paid', {}, 'acme')
    expect(urls()).toEqual(['https://acme.example/hook'])
  })

  it('a tenant may still re-register (update) its own endpoint by id', async () => {
    const store = new MemoryWebhookStore()
    const { d } = deliverer()
    const manager = new WebhookManager(store, d, { tenancyActive: () => true })
    const created = await asTenant('acme', () => manager.register({ url: 'https://acme.example/a', events: ['*'] }))
    await asTenant('acme', () => manager.register({ id: created.id, url: 'https://acme.example/b', events: ['*'] }))
    expect((await store.list('acme')).map((e) => e.url)).toEqual(['https://acme.example/b'])
  })

  it('an outbox flush started inside a tenant request does not deliver other tenants\' entries to that tenant', async () => {
    const store = new MemoryWebhookStore()
    const { d, urls } = deliverer()
    const manager = new WebhookManager(store, d)
    await store.add({ id: 'acme', url: 'https://acme.example/hook', events: ['*'], tenantId: 'acme', secret: `${SECRET}_a` })
    await store.add({ id: 'globex', url: 'https://globex.example/hook', events: ['*'], tenantId: 'globex', secret: `${SECRET}_g` })
    const outbox = new Outbox(new MemoryOutboxStore())
    await outbox.enqueue('invoice.paid', { invoice: 'globex-private' }, 'globex')
    await outbox.enqueue('system.tick', {}) // tenant-less entry
    // A route in acme's request triggers the relay manually (documented usage).
    await asTenant('acme', () => outbox.flush(webhookOutboxDispatch(manager)))
    expect(urls()).toEqual(['https://globex.example/hook'])
  })
})
