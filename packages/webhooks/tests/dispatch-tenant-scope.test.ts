import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext, tryCtx } from '@basaltkit/core'
import {
  MemoryWebhookStore,
  WebhookManager,
  WEBHOOKS,
  webhooksPlugin,
  type DeliveryResult,
  type TenantRunner,
  type WebhookDeliverer,
  type WebhookEndpoint,
  type WebhookStore,
} from '../src/index.js'

// An off-request dispatch scoped by an explicit tenantId runs ONLY its endpoint
// lookup inside the tenant runner (tenancyPlugin's 'tenancy:run'), so a store
// over tenantClient() can resolve the tenant's database while deliveries never
// hold that tenant's pooled client.

const SECRET = 'whsec_test_0123456789abcdef'
const contextTenant = () => (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id

/** A store that records the context tenant each forEvent ran under. */
function recordingStore() {
  const inner = new MemoryWebhookStore()
  const lookups: Array<string | undefined> = []
  const store: WebhookStore = {
    add: (e) => inner.add(e),
    remove: (id, t) => inner.remove(id, t),
    list: (t) => inner.list(t),
    forEvent: async (event, tenantId) => {
      lookups.push(contextTenant())
      return inner.forEvent(event, tenantId)
    },
  }
  return { store, inner, lookups }
}

/** A runner like tenancy.run: enters the tenant, tracks whether a run is live. */
function fakeRunner() {
  const calls: string[] = []
  const state = { inRun: 0 }
  const run: TenantRunner = async (tenantId, fn) => {
    calls.push(tenantId)
    state.inRun++
    try {
      return await runWithContext({ ...tryCtx(), tenant: { id: tenantId } } as never, fn)
    } finally {
      state.inRun--
    }
  }
  return { run, calls, state }
}

function fakeDeliverer(state?: { inRun: number }) {
  const sent: Array<{ endpoint: string; inRun: number | undefined; tenant: string | undefined }> = []
  const deliverer = {
    async deliver(endpoint: WebhookEndpoint): Promise<DeliveryResult> {
      sent.push({ endpoint: endpoint.id, inRun: state?.inRun, tenant: contextTenant() })
      return { endpointId: endpoint.id, ok: true, attempts: 1 }
    },
  } as unknown as WebhookDeliverer
  return { deliverer, sent }
}

async function seed(inner: MemoryWebhookStore) {
  await inner.add({ id: 'acme', url: 'https://acme.example/h', events: ['order.*'], tenantId: 'acme', secret: SECRET })
  await inner.add({ id: 'globex', url: 'https://globex.example/h', events: ['order.*'], tenantId: 'globex', secret: SECRET })
  await inner.add({ id: 'global', url: 'https://global.example/h', events: ['order.*'], secret: SECRET })
}

describe('WebhookManager.dispatch — runInTenant scopes only the endpoint lookup', () => {
  it('an explicit tenantId off-request enters the tenant for forEvent, then delivers outside the run', async () => {
    const { store, inner, lookups } = recordingStore()
    await seed(inner)
    const runner = fakeRunner()
    const { deliverer, sent } = fakeDeliverer(runner.state)
    const manager = new WebhookManager(store, deliverer, { runInTenant: runner.run })

    const results = await runWithContext({}, () => manager.dispatch('order.paid', {}, { tenantId: 'acme' }))

    expect(runner.calls).toEqual(['acme'])
    expect(lookups).toEqual(['acme'])
    expect(results.map((r) => r.endpointId).sort()).toEqual(['acme', 'global'])
    // The run had settled by the time any delivery ran, outside the tenant.
    expect(sent.every((s) => s.inRun === 0 && s.tenant === undefined)).toBe(true)
  })

  it('never calls the runner when a tenant is already in context (ambient wins)', async () => {
    const { store, inner, lookups } = recordingStore()
    await seed(inner)
    const runner = fakeRunner()
    const manager = new WebhookManager(store, fakeDeliverer().deliverer, { runInTenant: runner.run })

    const results = await runWithContext({ tenant: { id: 'globex' } } as never, () =>
      manager.dispatch('order.paid', {}, { tenantId: 'acme' }),
    )
    expect(runner.calls).toEqual([])
    expect(lookups).toEqual(['globex'])
    expect(results.map((r) => r.endpointId).sort()).toEqual(['global', 'globex'])
  })

  it('tenant-less and allTenants dispatches do not call the runner', async () => {
    const { store, inner } = recordingStore()
    await seed(inner)
    const runner = fakeRunner()
    const manager = new WebhookManager(store, fakeDeliverer().deliverer, { runInTenant: runner.run })

    expect((await manager.dispatch('order.paid', {})).map((r) => r.endpointId)).toEqual(['global'])
    expect((await manager.dispatch('order.paid', {}, { allTenants: true })).length).toBe(3)
    expect(runner.calls).toEqual([])
  })

  it('a runner failure (deleted tenant) rejects the dispatch before any delivery', async () => {
    const { store, inner } = recordingStore()
    await seed(inner)
    const { deliverer, sent } = fakeDeliverer()
    const notFound = Object.assign(new Error('tenant "acme" not found'), { code: 'TENANT_NOT_FOUND' })
    const manager = new WebhookManager(store, deliverer, { runInTenant: async () => Promise.reject(notFound) })

    await expect(manager.dispatch('order.paid', {}, { tenantId: 'acme' })).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' })
    expect(sent).toEqual([])
  })

  it('refuses a non-function runInTenant', () => {
    const { store } = recordingStore()
    expect(() => new WebhookManager(store, fakeDeliverer().deliverer, { runInTenant: 'yes' as never })).toThrow(TypeError)
  })
})

describe("webhooksPlugin wires runInTenant from the 'tenancy:run' signal", () => {
  /** Stands in for tenancyPlugin: publishes a runner under 'tenancy:run'. */
  const tenancyStub = (runner: TenantRunner) =>
    definePlugin({
      name: 'stub:tenancy',
      register({ container }) {
        ensureMetadata(container).add('tenancy:run', runner)
      },
    })

  const boot = async (plugins: ReturnType<typeof definePlugin>[]) => {
    const app = await createApp({ plugins }).boot()
    return { app, manager: app.container.get(WEBHOOKS) }
  }

  it('resolves the marker lazily, so a tenancy plugin registered AFTER webhooks still wires it', async () => {
    const { store, inner, lookups } = recordingStore()
    await seed(inner)
    const runner = fakeRunner()
    const { app, manager } = await boot([
      webhooksPlugin({ store, deliverer: fakeDeliverer().deliverer }),
      tenancyStub(runner.run),
    ])
    await manager.dispatch('order.paid', {}, { tenantId: 'acme' })
    expect(runner.calls).toEqual(['acme'])
    expect(lookups).toEqual(['acme'])
    await app.shutdown()
  })

  it('without the signal the lookup runs in the caller context (pre-signal behaviour)', async () => {
    const { store, inner, lookups } = recordingStore()
    await seed(inner)
    const { app, manager } = await boot([webhooksPlugin({ store, deliverer: fakeDeliverer().deliverer })])
    const results = await manager.dispatch('order.paid', {}, { tenantId: 'acme' })
    expect(lookups).toEqual([undefined])
    expect(results.map((r) => r.endpointId).sort()).toEqual(['acme', 'global'])
    await app.shutdown()
  })

  it('runInTenant: false disables the signal', async () => {
    const { store, inner, lookups } = recordingStore()
    await seed(inner)
    const runner = fakeRunner()
    const { app, manager } = await boot([
      tenancyStub(runner.run),
      webhooksPlugin({ store, deliverer: fakeDeliverer().deliverer, runInTenant: false }),
    ])
    await manager.dispatch('order.paid', {}, { tenantId: 'acme' })
    expect(runner.calls).toEqual([])
    expect(lookups).toEqual([undefined])
    await app.shutdown()
  })

  it('an explicit runner wins over the signal', async () => {
    const { store, inner } = recordingStore()
    await seed(inner)
    const fromSignal = fakeRunner()
    const explicit = fakeRunner()
    const { app, manager } = await boot([
      tenancyStub(fromSignal.run),
      webhooksPlugin({ store, deliverer: fakeDeliverer().deliverer, runInTenant: explicit.run }),
    ])
    await manager.dispatch('order.paid', {}, { tenantId: 'acme' })
    expect(explicit.calls).toEqual(['acme'])
    expect(fromSignal.calls).toEqual([])
    await app.shutdown()
  })
})
