import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaWebhookStore, type PrismaWebhooksClient, prismaWebhookStore } from '../src/index.js'

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
function mysqlLikeClient(): { client: PrismaWebhooksClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const cut = (data: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v]))
  const client: PrismaWebhooksClient = {
    webhookEndpoint: {
      async findMany() {
        return rows as never
      },
      async create({ data }) {
        rows.push(cut(data))
        return data
      },
      async updateMany() {
        return { count: 0 }
      },
      async deleteMany() {
        return { count: 0 }
      },
    },
  }
  return { client, rows }
}

const longUrl = `https://hooks.example.com/${'p'.repeat(300)}`

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard a long URL is cut — deliveries would go to another address', async () => {
    const { client, rows } = mysqlLikeClient()
    await new PrismaWebhookStore(client).add({ url: longUrl, events: ['*'] })
    expect((rows[0]!.url as string).length).toBe(191)
  })

  it("'mysql' accepts a long URL (TEXT) but refuses a >191 id or tenantId (VARCHAR(191))", async () => {
    const { client, rows } = mysqlLikeClient()
    const { store } = prismaWebhookStore(client, { columnLimits: 'mysql' })
    await store.add({ url: longUrl, events: ['*'] })
    expect(rows).toHaveLength(1)
    await expect(store.add({ url: 'https://x', events: ['*'], tenantId: 't'.repeat(192) })).rejects.toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      column: 'WebhookEndpoint.tenantId',
      limit: 191,
    })
    expect(rows).toHaveLength(1)
  })

  it('a custom VARCHAR(191) url column refuses a long URL instead of storing a different one', async () => {
    const { client, rows } = mysqlLikeClient()
    const store = new PrismaWebhookStore(client, { columnLimits: { WebhookEndpoint: { url: 191, secret: 191 } } })
    await expect(store.add({ url: longUrl, events: ['*'] })).rejects.toBeInstanceOf(ColumnLengthError)
    await expect(store.add({ url: 'https://x', events: ['*'], secret: 's'.repeat(200) })).rejects.toThrow(
      /WebhookEndpoint\.secret is 200 characters/,
    )
    expect(rows).toHaveLength(0)
  })

  it('unset: no check (PostgreSQL / SQLite)', async () => {
    const { client, rows } = mysqlLikeClient()
    await new PrismaWebhookStore(client).add({ url: 'https://x', events: ['*'], tenantId: 't'.repeat(500) })
    expect(rows).toHaveLength(1)
  })
})
