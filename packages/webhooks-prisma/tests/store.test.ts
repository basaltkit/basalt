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

/**
 * `collation: 'ci'` models MySQL's default case-insensitive collation, where
 * the primary key 'abc' and 'ABC' are the same row.
 */
function makeFakeClient(options: { collation?: 'ci' } = {}): PrismaWebhooksClient {
  const rows = new Map<string, Row>()
  const key = (id: string): string => (options.collation === 'ci' ? id.toLowerCase() : id)
  const same = (a: unknown, b: unknown): boolean =>
    typeof a === 'string' && typeof b === 'string' ? key(a) === key(b) : a === b
  return {
    webhookEndpoint: {
      async updateMany({ where, data }) {
        let count = 0
        for (const row of rows.values()) {
          if (same(row.id, where.id) && same(row.tenantId, where.tenantId)) {
            Object.assign(row, data)
            count++
          }
        }
        return { count }
      },
      async create({ data }) {
        if (rows.has(key(data.id))) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
        }
        const row: Row = { tenantId: null, secret: null, active: null, ...data }
        rows.set(key(row.id), row)
        return row
      },
      async findMany({ where, orderBy }) {
        let list = [...rows.values()].filter((r) => rowMatches(r, where))
        if (orderBy?.id === 'asc') list = list.sort((a, b) => a.id.localeCompare(b.id))
        return list
      },
      async deleteMany({ where }) {
        return { count: rows.delete(key(where.id)) ? 1 : 0 }
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

  // SECURITY INVARIANT: a direct read without a tenant is fail-closed — only
  // tenant-agnostic endpoints, never every tenant's, however "no tenant" is spelled.
  it.each([undefined, null, ''])('forEvent(event, %j) returns only tenant-agnostic endpoints', async (tenant) => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'global', url: 'u', events: ['*'] })
    await store.add({ id: 'acme', url: 'u', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'globex', url: 'u', events: ['*'], tenantId: 'globex' })

    expect((await store.forEvent('any', tenant as unknown as string)).map((e) => e.id)).toEqual(['global'])
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

// FA-069 (and D8): the write was an upsert keyed by `id` alone. Under MySQL's
// case-insensitive collation 'ABC' IS 'abc', so tenant A re-registering 'ABC'
// rewrote tenant B's endpoint — its url, its secret, its tenant. The manager's
// JS guard compares ids exactly and cannot see it; the store must refuse.
describe('add() never writes over another scope (FA-069)', () => {
  it("case-insensitive collation: tenant A's 'ABC' cannot rewrite tenant B's 'abc'", async () => {
    const store = new PrismaWebhookStore(makeFakeClient({ collation: 'ci' }))
    await store.add({ id: 'abc', url: 'https://b.test/hook', events: ['*'], tenantId: 'globex', secret: 'b' })

    await expect(
      store.add({ id: 'ABC', url: 'https://evil.test', events: ['*'], tenantId: 'acme', secret: 'a' }),
    ).rejects.toThrow(/already in use/)
    expect(await store.list()).toEqual([
      { id: 'abc', url: 'https://b.test/hook', events: ['*'], tenantId: 'globex', secret: 'b' },
    ])
  })

  it('an id owned by another tenant (or a global endpoint) is refused', async () => {
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'x', url: 'global', events: ['*'] })
    await store.add({ id: 'y', url: 'globex', events: ['*'], tenantId: 'globex' })

    await expect(store.add({ id: 'x', url: 'evil', events: ['*'], tenantId: 'acme' })).rejects.toThrow(/already in use/)
    await expect(store.add({ id: 'y', url: 'evil', events: ['*'] })).rejects.toThrow(/already in use/)
    expect((await store.list()).map((e) => e.url)).toEqual(['global', 'globex'])
  })

  it('the same tenant re-adding its own id still replaces it', async () => {
    const store = new PrismaWebhookStore(makeFakeClient({ collation: 'ci' }))
    await store.add({ id: 'x', url: 'old', events: ['*'], tenantId: 'acme', secret: 's' })
    await store.add({ id: 'x', url: 'new', events: ['invoice.*'], tenantId: 'acme' })
    expect(await store.list('acme')).toEqual([{ id: 'x', url: 'new', events: ['invoice.*'], tenantId: 'acme' }])
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

describe('WebhookEndpointIdInUseError is the @basaltkit/webhooks class', () => {
  it('re-exported, and what add() throws is an instance of the core class', async () => {
    const core = await import('@basaltkit/webhooks')
    const { WebhookEndpointIdInUseError } = await import('../src/index.js')
    expect(WebhookEndpointIdInUseError).toBe(core.WebhookEndpointIdInUseError)
    const store = new PrismaWebhookStore(makeFakeClient())
    await store.add({ id: 'x', url: 'https://globex.test', events: ['*'], tenantId: 'globex' })
    const err = await store.add({ id: 'x', url: 'https://evil.test', events: ['*'], tenantId: 'acme' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(core.WebhookEndpointIdInUseError)
    expect(err).toMatchObject({ code: 'WEBHOOK_ENDPOINT_ID_IN_USE', status: 409, name: 'WebhookEndpointIdInUseError' })
  })
})
