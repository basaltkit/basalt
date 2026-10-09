import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata, definePlugin, runWithContext, tryCtx } from '@basaltkit/core'
import {
  EVENTS,
  MemoryOutboxStore,
  OUTBOX,
  Outbox,
  defineEvent,
  eventsPlugin,
  outboxPlugin,
  type OutboxEntry,
} from '@basaltkit/events'
import {
  MemoryWebhookStore,
  WebhookManager,
  WEBHOOKS,
  webhookOutboxDispatch,
  webhookOutboxPlugin,
  webhooksPlugin,
  type DeliveryResult,
  type TenantRunner,
  type WebhookDeliverer,
  type WebhookEndpoint,
} from '../src/index.js'

// The outbox relay dispatches each entry from a fresh `{}` context scoped by the
// entry's own tenant; the manager's runInTenant enters that tenant for the
// endpoint lookup. Every wiring path gets it: webhookOutboxPlugin, the
// outboxPlugin + webhookOutboxDispatch recipe, and manual flushes.

const SECRET = 'whsec_test_0123456789abcdef'
const contextTenant = () => (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
const OrderPaid = defineEvent<{ id: string }>('order.paid')
const tick = () => new Promise((r) => setImmediate(r))

function fakeRunner(fail?: () => unknown) {
  const calls: string[] = []
  const run: TenantRunner = async (tenantId, fn) => {
    calls.push(tenantId)
    if (fail) throw fail()
    return runWithContext({ ...tryCtx(), tenant: { id: tenantId } } as never, fn)
  }
  return { run, calls }
}

function deliverer(outcome: (endpoint: WebhookEndpoint) => boolean = () => true) {
  const sent: Array<{ endpoint: string; deliveryId: string | undefined }> = []
  const d = {
    async deliver(endpoint: WebhookEndpoint, _e: string, _d: unknown, opts?: { deliveryId?: string }): Promise<DeliveryResult> {
      sent.push({ endpoint: endpoint.id, deliveryId: opts?.deliveryId })
      const ok = outcome(endpoint)
      return ok ? { endpointId: endpoint.id, ok, attempts: 1 } : { endpointId: endpoint.id, ok, attempts: 1, error: 'HTTP 503', retryable: true }
    },
  } as unknown as WebhookDeliverer
  return { deliverer: d, sent }
}

async function seededStore() {
  const store = new MemoryWebhookStore()
  await store.add({ id: 'acme-1', url: 'https://acme.example/h', events: ['order.*'], tenantId: 'acme', secret: SECRET })
  await store.add({ id: 'acme-2', url: 'https://acme2.example/h', events: ['order.*'], tenantId: 'acme', secret: SECRET })
  await store.add({ id: 'beta-1', url: 'https://beta.example/h', events: ['order.*'], tenantId: 'beta', secret: SECRET })
  return store
}

const tenancyStub = (runner: TenantRunner) =>
  definePlugin({
    name: 'stub:tenancy',
    register({ container }) {
      ensureMetadata(container).add('tenancy:run', runner)
    },
  })

describe('webhookOutboxDispatch enters the entry tenant for the endpoint lookup', () => {
  it("a flush started inside another tenant's context still routes acme's entry to acme only", async () => {
    const runner = fakeRunner()
    const { deliverer: d, sent } = deliverer()
    const manager = new WebhookManager(await seededStore(), d, { runInTenant: runner.run })
    const outbox = new Outbox(new MemoryOutboxStore(), { backoff: false })
    await outbox.enqueue('order.paid', { id: 'o1' }, 'acme')

    const result = await runWithContext({ tenant: { id: 'beta' } } as never, () =>
      outbox.flush(webhookOutboxDispatch(manager)),
    )
    expect(result).toEqual({ published: 1, failed: 0 })
    expect(runner.calls).toEqual(['acme'])
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['acme-1', 'acme-2'])
  })

  it('a runner failure marks the entry failed, then dead-letters it after maxAttempts', async () => {
    const notFound = () => Object.assign(new Error('tenant "acme" not found'), { code: 'TENANT_NOT_FOUND' })
    const runner = fakeRunner(notFound)
    const { deliverer: d, sent } = deliverer()
    const manager = new WebhookManager(await seededStore(), d, { runInTenant: runner.run })
    const dead: Array<{ entry: OutboxEntry; error: unknown }> = []
    const outbox = new Outbox(new MemoryOutboxStore(), { backoff: false, maxAttempts: 2, onDead: (entry, error) => dead.push({ entry, error }) })
    await outbox.enqueue('order.paid', { id: 'o1' }, 'acme')
    const dispatch = webhookOutboxDispatch(manager)

    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 1 })
    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 1 })
    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 0 }) // dead: no longer pending
    expect(dead).toHaveLength(1)
    expect(dead[0]!.error).toMatchObject({ code: 'TENANT_NOT_FOUND' })
    expect(sent).toEqual([])
  })

  it('retries keep the stable delivery id and skip endpoints that already accepted', async () => {
    const runner = fakeRunner()
    let acme2Up = false
    const { deliverer: d, sent } = deliverer((e) => e.id !== 'acme-2' || acme2Up)
    const manager = new WebhookManager(await seededStore(), d, { runInTenant: runner.run })
    const outbox = new Outbox(new MemoryOutboxStore(), { backoff: false })
    await outbox.enqueue('order.paid', { id: 'o1' }, 'acme')
    const dispatch = webhookOutboxDispatch(manager)

    expect(await outbox.flush(dispatch)).toEqual({ published: 0, failed: 1 })
    acme2Up = true
    expect(await outbox.flush(dispatch)).toEqual({ published: 1, failed: 0 })

    expect(runner.calls).toEqual(['acme', 'acme'])
    expect(sent.map((s) => s.endpoint)).toEqual(['acme-1', 'acme-2', 'acme-2']) // acme-1 skipped on retry
    expect(sent[1]!.deliveryId).toBe(sent[2]!.deliveryId)
  })
})

describe('every wiring path gets the runner from the tenancy signal', () => {
  it('the outboxPlugin + webhookOutboxDispatch(WEBHOOKS) recipe enters the tenant', async () => {
    const runner = fakeRunner()
    const { deliverer: d, sent } = deliverer()
    const webhooks = webhooksPlugin({ store: await seededStore(), deliverer: d })
    let dispatch: ReturnType<typeof webhookOutboxDispatch> | undefined
    const app = await createApp({
      plugins: [
        tenancyStub(runner.run),
        eventsPlugin(),
        webhooks,
        // The docs' recipe: dispatch built from the container's manager.
        outboxPlugin({ captureEvents: ['order.*'], dispatch: (entry) => dispatch!(entry) }),
      ],
    }).boot()
    dispatch = webhookOutboxDispatch(app.container.get(WEBHOOKS))

    await runWithContext({ tenant: { id: 'acme' } } as never, () => app.container.get(EVENTS).emit(OrderPaid, { id: 'o1' }))
    await tick()
    expect(await app.container.get(OUTBOX).flush(dispatch)).toEqual({ published: 1, failed: 0 })
    expect(runner.calls).toEqual(['acme'])
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['acme-1', 'acme-2'])
    await app.shutdown()
  })
})

describe('webhookOutboxPlugin tenantOnly', () => {
  const boot = async (tenantOnly?: boolean) => {
    const app = await createApp({
      plugins: [
        eventsPlugin(),
        webhooksPlugin({ deliverer: deliverer().deliverer }),
        webhookOutboxPlugin({ intervalMs: 0, ...(tenantOnly !== undefined ? { tenantOnly } : {}) }),
      ],
    }).boot()
    const bus = app.container.get(EVENTS)
    await bus.emit(OrderPaid, { id: 'central' })
    await runWithContext({ tenant: { id: 'acme' } } as never, () => bus.emit(OrderPaid, { id: 'tenant' }))
    await tick()
    const seen: Array<string | undefined> = []
    await app.container.get(OUTBOX).flush(async (entry) => void seen.push(entry.tenantId ?? undefined))
    await app.shutdown()
    return seen
  }

  it('captures tenant-less events by default', async () => {
    expect((await boot()).sort()).toEqual(['acme', undefined])
  })

  it('tenantOnly: true skips events emitted without a tenant', async () => {
    expect(await boot(true)).toEqual(['acme'])
  })

  it('the plugin relay delivers inside the entry tenant (no stray context)', async () => {
    const runner = fakeRunner()
    const seenTenant: Array<string | undefined> = []
    const store = await seededStore()
    const original = store.forEvent.bind(store)
    store.forEvent = async (event, tenantId) => {
      seenTenant.push(contextTenant())
      return original(event, tenantId)
    }
    const app = await createApp({
      plugins: [
        tenancyStub(runner.run),
        eventsPlugin(),
        webhooksPlugin({ store, deliverer: deliverer().deliverer }),
        webhookOutboxPlugin({ intervalMs: 0, tenantOnly: true }),
      ],
    }).boot()
    await runWithContext({ tenant: { id: 'acme' } } as never, () => app.container.get(EVENTS).emit(OrderPaid, { id: 'o1' }))
    await tick()
    expect(await app.container.get(OUTBOX).flush(webhookOutboxDispatch(app.container.get(WEBHOOKS)))).toEqual({ published: 1, failed: 0 })
    expect(seenTenant).toEqual(['acme'])
    await app.shutdown()
  })
})
