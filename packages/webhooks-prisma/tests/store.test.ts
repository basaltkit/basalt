import { describe, expect, it } from 'vitest'
import { PrismaWebhookStore, type PrismaWebhooksClient, prismaWebhookStore } from '../src/index.js'

interface Row {
  id: string
  url: string
  events: string
  tenantId: string | null
  secret: string | null
  active: boolean | null
}

// Generic where-matcher covering the AND/OR/equality shapes the store produces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowMatches(row: Row, where: any): boolean {
  for (const [key, val] of Object.entries(where ?? {})) {
    if (key === 'AND') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(val as any[]).every((c) => rowMatches(row, c))) return false
    } else if (key === 'OR') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(val as any[]).some((c) => rowMatches(row, c))) return false
    } else if ((row as unknown as Record<string, unknown>)[key] !== val) {
      return false
    }
  }
  return true
}

function makeFakeClient(): PrismaWebhooksClient {
  const rows = new Map<string, Row>()
  return {
    webhookEndpoint: {
      async findMany({ where, orderBy }) {
        let list = [...rows.values()].filter((r) => rowMatches(r, where))
        if (orderBy?.id === 'asc') list = list.sort((a, b) => a.id.localeCompare(b.id))
        return list
      },
      async upsert({ where, create, update }) {
        const existing = rows.get(where.id)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row: Row = {
          id: create.id,
          url: create.url,
          events: create.events,
          tenantId: create.tenantId ?? null,
          secret: create.secret ?? null,
          active: create.active ?? null,
        }
        rows.set(row.id, row)
        return row
      },
      async deleteMany({ where }) {
        return { count: rows.delete(where.id) ? 1 : 0 }
      },
    },
  }
}

describe('PrismaWebhookStore', () => {
  it('adds (auto id) and round-trips every field', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    const ep = await store.add({ url: 'https://a.test', events: ['invoice.*'], secret: 's', tenantId: 'acme' })
    expect(ep.id).toMatch(/[0-9a-f-]{36}/)
    expect(await store.list()).toEqual([
      { id: ep.id, url: 'https://a.test', events: ['invoice.*'], secret: 's', tenantId: 'acme' },
    ])
  })

  it('forEvent matches patterns and skips inactive', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'exact', url: 'u', events: ['invoice.paid'] })
    await store.add({ id: 'prefix', url: 'u', events: ['invoice.*'] })
    await store.add({ id: 'star', url: 'u', events: ['*'] })
    await store.add({ id: 'other', url: 'u', events: ['order.created'] })
    await store.add({ id: 'off', url: 'u', events: ['invoice.paid'], active: false })

    expect((await store.forEvent('invoice.paid')).map((e) => e.id).sort()).toEqual(['exact', 'prefix', 'star'])
  })

  it('forEvent scopes by tenant (tenant-agnostic endpoints always match)', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'global', url: 'u', events: ['*'] })
    await store.add({ id: 'acme', url: 'u', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'globex', url: 'u', events: ['*'], tenantId: 'globex' })

    expect((await store.forEvent('any', 'acme')).map((e) => e.id).sort()).toEqual(['acme', 'global'])
  })

  it('list filters by exact tenant; remove deletes', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'a', url: 'u', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'b', url: 'u', events: ['*'] })

    expect((await store.list('acme')).map((e) => e.id)).toEqual(['a'])
    await store.remove('a')
    expect((await store.list('acme')).length).toBe(0)
  })

  it('re-adding the same id replaces the endpoint', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'x', url: 'old', events: ['*'] })
    await store.add({ id: 'x', url: 'new', events: ['invoice.*'] })
    const [ep] = await store.list()
    expect(ep?.url).toBe('new')
    expect(ep?.events).toEqual(['invoice.*'])
  })
})

describe('prismaWebhookStore', () => {
  it('returns a store ready for webhooksPlugin({ store })', () => {
    expect(prismaWebhookStore(makeFakeClient()).store).toBeInstanceOf(PrismaWebhookStore)
  })

  it('fails fast when the client lacks the WebhookEndpoint model', () => {
    expect(() => prismaWebhookStore({} as unknown as PrismaWebhooksClient)).toThrow(
      /has no `webhookEndpoint` model/,
    )
  })
})
