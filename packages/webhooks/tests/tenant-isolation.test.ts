import { describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import {
  matchesEvent,
  MemoryWebhookStore,
  WebhookDeliverer,
  WebhookManager,
  WebhookTenantRequiredError,
  WEBHOOKS,
  webhooksPlugin,
} from '../src/index.js'

const SECRET = 'whsec_test_0123456789abcdef'
const publicDns = { lookup: async () => [{ address: '93.184.216.34' }] }
const okResponse = () => ({ ok: true, status: 200 }) as unknown as Response
const asTenant = <T>(id: string, fn: () => T): T => runWithContext({ tenant: { id } } as never, fn)

async function setup(tenancyActive = false) {
  const store = new MemoryWebhookStore()
  const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse())
  const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns })
  const manager = new WebhookManager(store, deliverer, { tenancyActive: () => tenancyActive })
  await store.add({ id: 'acme', url: 'https://acme.example/hook', events: ['invoice.*'], tenantId: 'acme', secret: `${SECRET}_acme` })
  await store.add({ id: 'globex', url: 'https://globex.example/hook', events: ['invoice.*'], tenantId: 'globex', secret: `${SECRET}_globex` })
  const urls = () => fetchImpl.mock.calls.map((c) => String(c[0]))
  return { store, manager, fetchImpl, urls }
}

/**
 * SECURITY INVARIANT: a tenant's endpoint only ever receives events of that
 * tenant (or of no tenant when it is explicitly global). A dispatch without a
 * tenant (scheduler job, billing webhook, central route) must never fan out to
 * tenant-bound endpoints, and management calls must not run unscoped or leak
 * signing secrets.
 */
describe('webhooks tenant isolation (fail closed without a tenant)', () => {
  it('a tenant-less dispatch does not reach tenant-bound endpoints', async () => {
    const { manager, urls } = await setup()
    await manager.dispatch('invoice.paid', { invoice: 'acme-secret-data' })
    expect(urls()).toEqual([])
  })

  it('a tenant-less dispatch still reaches tenant-agnostic (global) endpoints', async () => {
    const { manager, store, urls } = await setup()
    await store.add({ id: 'g', url: 'https://global.example/hook', events: ['invoice.*'], secret: SECRET })
    await manager.dispatch('invoice.paid', {})
    expect(urls()).toEqual(['https://global.example/hook'])
  })

  it('system fan-out to every tenant requires the explicit allTenants opt-in', async () => {
    const { manager, urls } = await setup()
    await manager.dispatch('maintenance.scheduled', {}, { allTenants: true })
    expect(urls()).toEqual([]) // no endpoint subscribed to maintenance.*
    await manager.dispatch('invoice.paid', {}, { allTenants: true })
    expect(urls().sort()).toEqual(['https://acme.example/hook', 'https://globex.example/hook'])
  })

  it('allTenants is ignored inside a tenant context (anti-widening)', async () => {
    const { manager, urls } = await setup()
    await asTenant('acme', () => manager.dispatch('invoice.paid', {}, { allTenants: true }))
    expect(urls()).toEqual(['https://acme.example/hook'])
  })

  it('an explicit tenantId still scopes a dispatch off the request path', async () => {
    const { manager, urls } = await setup()
    await manager.dispatch('invoice.paid', {}, 'globex')
    expect(urls()).toEqual(['https://globex.example/hook'])
  })

  it('a store that ignores the tenant filter cannot widen a tenant dispatch (defense in depth)', async () => {
    const { store, fetchImpl } = await setup()
    // Ignores the tenant argument entirely and returns EVERY tenant's endpoints.
    const leaky = { ...store, forEvent: async (event: string) => (await store.list()).filter((e) => matchesEvent(e.events, event)), add: store.add.bind(store), remove: store.remove.bind(store), list: store.list.bind(store) }
    const deliverer = new WebhookDeliverer({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, ssrf: publicDns })
    const manager = new WebhookManager(leaky, deliverer)
    await manager.dispatch('invoice.paid', {}, 'acme')
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(['https://acme.example/hook'])
  })

  it('auto-dispatch of an event emitted outside a request does not reach tenant endpoints', async () => {
    const store = new MemoryWebhookStore()
    const delivered: string[] = []
    const deliverer = {
      deliver: async (ep: { id: string }, event: string) => {
        delivered.push(`${ep.id}:${event}`)
        return { endpointId: ep.id, ok: true, attempts: 1 }
      },
    } as unknown as WebhookDeliverer
    const app = await createApp({
      plugins: [eventsPlugin(), webhooksPlugin({ store, deliverer, events: ['invoice.*'] })],
    }).boot()
    await store.add({ id: 'globex', url: 'https://globex.example/hook', events: ['invoice.*'], tenantId: 'globex' })
    await app.container.get(EVENTS).emit(defineEvent<{ amount: number }>('invoice.paid'), { amount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delivered).toEqual([])
    await app.shutdown()
  })

  it('list() never returns signing secrets', async () => {
    const { manager } = await setup()
    const listed = await manager.list()
    expect(listed.length).toBe(2)
    for (const endpoint of listed) {
      expect(endpoint).not.toHaveProperty('secret')
      expect(endpoint.hasSecret).toBe(true)
    }
    const scoped = await asTenant('acme', () => manager.list())
    expect(scoped.map((e) => e.id)).toEqual(['acme'])
    expect(scoped[0]).not.toHaveProperty('secret')
  })

  describe('with tenancy active', () => {
    it('register without a ctx tenant or explicit tenantId throws instead of creating a global endpoint', async () => {
      const { manager, store } = await setup(true)
      await expect(manager.register({ url: 'https://evil.example/h', events: ['*'] })).rejects.toBeInstanceOf(WebhookTenantRequiredError)
      expect((await store.list()).some((e) => e.url === 'https://evil.example/h')).toBe(false)
    })

    it('register with an explicit tenantId (system code) or { system: true } is allowed', async () => {
      const { manager } = await setup(true)
      const bound = await manager.register({ url: 'https://initech.example/h', events: ['*'], tenantId: 'initech' })
      expect(bound.tenantId).toBe('initech')
      const global = await manager.register({ url: 'https://ops.example/h', events: ['*'] }, { system: true })
      expect(global.tenantId).toBeUndefined()
    })

    it('list without a ctx tenant or explicit tenantId throws unless { system: true }', async () => {
      const { manager } = await setup(true)
      await expect(manager.list()).rejects.toBeInstanceOf(WebhookTenantRequiredError)
      expect((await manager.list('acme')).map((e) => e.id)).toEqual(['acme'])
      expect((await manager.list(undefined, { system: true })).length).toBe(2)
    })

    it('unregister without a ctx tenant throws unless scoped explicitly or { system: true }', async () => {
      const { manager, store } = await setup(true)
      await expect(manager.unregister('globex')).rejects.toBeInstanceOf(WebhookTenantRequiredError)
      expect((await store.list()).length).toBe(2)
      await manager.unregister('globex', { tenantId: 'acme' }) // wrong owner → no-op
      expect((await store.list()).length).toBe(2)
      await manager.unregister('globex', { system: true })
      expect((await store.list()).length).toBe(1)
    })

    it('webhooksPlugin reads the tenancy:active marker', async () => {
      const tenancyMarker = definePlugin({
        name: 'test:tenancy-marker',
        register({ container }) {
          ensureMetadata(container).add('tenancy:active', true as never)
        },
      })
      const app = await createApp({ plugins: [tenancyMarker, webhooksPlugin({ secret: SECRET })] }).boot()
      await expect(app.container.get(WEBHOOKS).list()).rejects.toBeInstanceOf(WebhookTenantRequiredError)
      await app.shutdown()
    })
  })
})
