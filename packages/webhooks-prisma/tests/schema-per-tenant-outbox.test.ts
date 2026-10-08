import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { EVENTS, MemoryOutboxStore, OUTBOX, defineEvent, eventsPlugin } from '@basaltkit/events'
import { DB_POOL, db, prismaPlugin, tenantClient } from '@basaltkit/prisma'
import { MemoryTenantSource, TENANCY, tenancyPlugin } from '@basaltkit/tenancy'
import {
  WEBHOOKS,
  webhookOutboxDispatch,
  webhookOutboxPlugin,
  webhooksPlugin,
  type DeliveryResult,
  type WebhookDeliverer,
  type WebhookEndpoint,
} from '@basaltkit/webhooks'
import { prismaWebhookStore, type PrismaWebhooksClient } from '../src/index.js'

// End to end, no real database: endpoints live per tenant (a store over
// tenantClient(), each tenant its own client from prismaPlugin's pool) while
// the outbox stays central. The relay must reach each entry's tenant database
// for the endpoint lookup — and only for it: a delivery never holds the
// tenant's pooled client, so a slow endpoint cannot starve request traffic.

const SECRET = 'whsec_test_0123456789abcdef'
const OrderPaid = defineEvent<{ id: string }>('order.paid')
const tick = () => new Promise((r) => setImmediate(r))

interface Row {
  id: string
  url: string
  events: string
  tenantId: string | null
  secret: string | null
  active: boolean | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const matches = (row: Row, where: any): boolean =>
  Object.entries(where ?? {}).every(([key, val]) =>
    key === 'AND'
      ? (val as unknown[]).every((c) => matches(row, c))
      : key === 'OR'
        ? (val as unknown[]).some((c) => matches(row, c))
        : (row as unknown as Record<string, unknown>)[key] === val,
  )

/** One in-memory "database" per tenant, surviving client re-creation by the pool. */
const databases = new Map<string, Map<string, Row>>()
function fakeClient(tenantId: string): PrismaWebhooksClient {
  const rows = databases.get(tenantId) ?? new Map<string, Row>()
  databases.set(tenantId, rows)
  return {
    webhookEndpoint: {
      async findMany({ where }) {
        return [...rows.values()].filter((r) => matches(r, where))
      },
      async create({ data }) {
        const row: Row = { tenantId: null, secret: null, active: null, ...data }
        rows.set(row.id, row)
        return row
      },
      async updateMany() {
        return { count: 0 }
      },
      async deleteMany({ where }) {
        return { count: rows.delete(where.id) ? 1 : 0 }
      },
    },
  }
}

function gatedDeliverer() {
  const sent: string[] = []
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  let entered: () => void = () => {}
  let started = new Promise<void>((r) => (entered = r))
  const deliverer = {
    async deliver(endpoint: WebhookEndpoint): Promise<DeliveryResult> {
      sent.push(endpoint.id)
      entered()
      await gate
      return { endpointId: endpoint.id, ok: true, attempts: 1 }
    },
  } as unknown as WebhookDeliverer
  return {
    deliverer,
    sent,
    block: () => {
      gate = new Promise((r) => (open = r))
      started = new Promise((r) => (entered = r))
    },
    started: () => started,
    release: () => open(),
  }
}

async function boot(options: { runInTenant?: false; dispatchTimeoutMs?: number } = {}) {
  databases.clear()
  const d = gatedDeliverer()
  const outboxStore = new MemoryOutboxStore()
  const app = await createApp({
    plugins: [
      tenancyPlugin({
        source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme' }).add({ id: 'globex', name: 'Globex' }),
        resolvers: [],
      }),
      // One client slot, no idle grace: any lease held through a delivery
      // would make the next tenant's acquire time out.
      prismaPlugin({ forTenant: (id: string) => fakeClient(id), max: 1, idleMs: 0, acquireTimeoutMs: 300 }),
      eventsPlugin(),
      webhooksPlugin({
        store: prismaWebhookStore(tenantClient<PrismaWebhooksClient>()).store,
        deliverer: d.deliverer,
        ...(options.runInTenant === false ? { runInTenant: false as const } : {}),
      }),
      webhookOutboxPlugin({
        store: outboxStore,
        intervalMs: 0,
        tenantOnly: true,
        ...(options.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: options.dispatchTimeoutMs } : {}),
      }),
    ],
  }).boot()

  // Count outstanding pool leases (prismaPlugin leases for tenancy.run()).
  const pool = app.container.get(DB_POOL)
  const acquire = pool.acquire.bind(pool)
  const leases = { open: 0 }
  pool.acquire = async (tenantId: string) => {
    const lease = await acquire(tenantId)
    leases.open++
    let done = false
    return {
      client: lease.client,
      release: () => {
        if (!done) leases.open--
        done = true
        lease.release()
      },
    }
  }

  const tenancy = app.container.get(TENANCY)
  const endpointStore = prismaWebhookStore(tenantClient<PrismaWebhooksClient>()).store
  for (const id of ['acme', 'globex']) {
    await tenancy.run(id, () =>
      endpointStore.add({ id: `${id}-hook`, url: `https://${id}.example/h`, events: ['order.*'], tenantId: id, secret: SECRET }),
    )
  }
  const bus = app.container.get(EVENTS)
  const outbox = app.container.get(OUTBOX)
  const flush = () => runWithContext({}, () => outbox.flush(webhookOutboxDispatch(app.container.get(WEBHOOKS))))
  return { app, d, tenancy, bus, outbox, outboxStore, flush, leases }
}

describe('webhook outbox under schema-per-tenant (endpoints over tenantClient())', () => {
  it("delivers an entry to its tenant's endpoints only, and leaks no lease", async () => {
    const { app, d, tenancy, bus, flush, outboxStore, leases } = await boot()
    await tenancy.run('acme', () => bus.emit(OrderPaid, { id: 'o1' }))
    await bus.emit(OrderPaid, { id: 'central' }) // tenantOnly: not captured
    await tick()
    expect((await outboxStore.pending(10, 10)).map((e) => e.tenantId)).toEqual(['acme'])

    expect(await flush()).toMatchObject({ published: 1, failed: 0 })
    expect(d.sent).toEqual(['acme-hook'])
    expect(leases.open).toBe(0)
    await app.shutdown()
  })

  it('holds no lease during delivery, so another tenant still gets the only client slot', async () => {
    const { app, d, tenancy, bus, flush, leases } = await boot()
    await tenancy.run('acme', () => bus.emit(OrderPaid, { id: 'o1' }))
    await tick()

    d.block()
    const flushing = flush()
    await d.started() // acme's delivery is in flight and stuck
    expect(leases.open).toBe(0)
    // A stand-in for a globex request: with max 1 it would time out if the
    // relay still leased acme's client.
    const rows = await tenancy.run('globex', () =>
      db<PrismaWebhooksClient>().webhookEndpoint.findMany({ where: {} }),
    )
    expect(rows.map((r) => r.id)).toEqual(['globex-hook'])

    d.release()
    expect(await flushing).toMatchObject({ published: 1, failed: 0 })
    expect(leases.open).toBe(0)
    await app.shutdown()
  })

  it('a delivery detached past dispatchTimeoutMs holds no lease, and shutdown leaks none', async () => {
    const { app, d, tenancy, bus, flush, leases } = await boot({ dispatchTimeoutMs: 1 })
    await tenancy.run('acme', () => bus.emit(OrderPaid, { id: 'o1' }))
    await tick()

    d.block()
    const result = await flush()
    expect(result.detached).toBe(1) // the flush moved on; the delivery runs detached
    await d.started()
    expect(leases.open).toBe(0)

    d.release()
    await tick()
    await app.shutdown()
    expect(leases.open).toBe(0)
    expect(d.sent).toEqual(['acme-hook'])
  })

  it('regression: without the tenant runner the lookup has no database (DB_UNAVAILABLE)', async () => {
    const { app, d, tenancy, bus, flush, outboxStore } = await boot({ runInTenant: false })
    await tenancy.run('acme', () => bus.emit(OrderPaid, { id: 'o1' }))
    await tick()

    const [entry] = await outboxStore.pending(10, 10)
    await expect(
      runWithContext({}, () => webhookOutboxDispatch(app.container.get(WEBHOOKS))(entry!)),
    ).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' })
    expect(await flush()).toMatchObject({ published: 0, failed: 1 })
    expect(d.sent).toEqual([])
    await app.shutdown()
  })
})
