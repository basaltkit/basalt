import { describe, expect, it, vi } from 'vitest'
import { verifySignature, WebhookDeliverer, WebhookManager } from '@basaltkit/webhooks'
import { PrismaWebhookStore, type PrismaWebhooksClient } from '../src/index.js'

type Row = Record<string, unknown> & { id: string; tenantId: string | null }

/**
 * A fake Prisma client that, like a real generated one, rejects a column its
 * schema does not have. `columns` is the schema: legacy (no rotation columns)
 * or current.
 */
function fakeClient(columns: string[]): PrismaWebhooksClient & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const check = (data: Record<string, unknown>) => {
    for (const k of Object.keys(data)) if (!columns.includes(k)) throw new Error(`Unknown argument \`${k}\``)
  }
  const matches = (r: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true
    if (Array.isArray(where.AND)) return (where.AND as Record<string, unknown>[]).every((w) => matches(r, w))
    if (Array.isArray(where.OR)) return (where.OR as Record<string, unknown>[]).some((w) => matches(r, w))
    return Object.entries(where).every(([k, v]) => (r[k] ?? null) === v)
  }
  const blank = Object.fromEntries(columns.map((c) => [c, null]))
  return {
    rows,
    webhookEndpoint: {
      async findMany({ where }: { where?: Record<string, unknown> } = {}) {
        return [...rows.values()].filter((r) => matches(r, where)) as never
      },
      async create({ data }: { data: Row }) {
        check(data)
        if (rows.has(data.id)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = { ...blank, ...data }
        rows.set(data.id, row)
        return row as never
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        check(data)
        let count = 0
        for (const r of rows.values()) if (matches(r, where)) (Object.assign(r, data), count++)
        return { count }
      },
      async deleteMany() {
        return { count: 0 }
      },
    },
  }
}

const LEGACY = ['id', 'url', 'events', 'tenantId', 'secret', 'active']
const CURRENT = [...LEGACY, 'previousSecret', 'previousSecretExpiresAt']

describe('PrismaWebhookStore — secret rotation columns', () => {
  it('a schema without the rotation columns keeps working for register/list/forEvent', async () => {
    const store = new PrismaWebhookStore(fakeClient(LEGACY))
    const mgr = new WebhookManager(store, new WebhookDeliverer({ ssrf: false }))
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    await mgr.register({ id: e.id, url: 'https://hook2.example/', events: ['*'], tenantId: 'acme' })
    expect(await store.forEvent('x', 'acme')).toHaveLength(1)
  })

  it('persists and reads back the grace window; both secrets sign', async () => {
    const client = fakeClient(CURRENT)
    const store = new PrismaWebhookStore(client)
    const fx = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }))
    const mgr = new WebhookManager(store, new WebhookDeliverer({ fetchImpl: fx as never, ssrf: false }))
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const rotated = await mgr.rotateSecret(e.id, { tenantId: 'acme', graceSeconds: 600 })
    const [row] = await store.list('acme')
    expect(row).toMatchObject({ secret: rotated.secret, previousSecret: e.secret })
    expect(row!.previousSecretExpiresAt).toBeInstanceOf(Date)

    await mgr.dispatch('a.b', {}, 'acme')
    const init = fx.mock.calls[0]![1]
    const header = (init.headers as Record<string, string>)['x-basalt-signature']!
    expect(verifySignature(header, init.body as string, e.secret!)).toBe(true)
    expect(verifySignature(header, init.body as string, rotated.secret!)).toBe(true)

    // Re-registering ends the rotation: the columns are cleared.
    await mgr.register({ id: e.id, url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    expect(client.rows.get(e.id)).toMatchObject({ previousSecret: null, previousSecretExpiresAt: null })
    expect((await store.list('acme'))[0]).not.toHaveProperty('previousSecret')
  })

  it("columnLimits: 'mysql' checks previousSecret too", async () => {
    const store = new PrismaWebhookStore(fakeClient(CURRENT), { columnLimits: 'mysql' })
    await expect(
      store.add({ url: 'u', events: ['*'], previousSecret: 'x'.repeat(70_000), previousSecretExpiresAt: new Date() }),
    ).rejects.toThrow('WebhookEndpoint.previousSecret')
  })
})
