import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaInAppStore, type PrismaNotificationsClient, prismaInAppStore } from '../src/index.js'

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
function mysqlLikeClient(): { client: PrismaNotificationsClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const client: PrismaNotificationsClient = {
    inAppNotification: {
      async create({ data }) {
        rows.push(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v])))
        return data
      },
      async findMany() {
        return []
      },
      async updateMany() {
        return { count: 0 }
      },
      async count() {
        return 0
      },
    },
  }
  return { client, rows }
}

const n = { id: 'n1', recipientId: 'u1', notification: 'invoice.paid', title: 'Paid', at: 1 }

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard a long body is cut and `data` stops being JSON', async () => {
    const { client, rows } = mysqlLikeClient()
    await new PrismaInAppStore(client).append({ ...n, data: { items: 'x'.repeat(300) } })
    expect(() => JSON.parse(rows[0]!.data as string)).toThrow()
  })

  it("'mysql' stores a long body/data (TEXT/MEDIUMTEXT) and refuses a >191 recipientId", async () => {
    const { client, rows } = mysqlLikeClient()
    const { store } = prismaInAppStore(client, { columnLimits: 'mysql' })
    await store.append({ ...n, body: 'b'.repeat(5000), data: { items: 'x'.repeat(300) } })
    await expect(store.append({ ...n, id: 'n2', recipientId: 'u'.repeat(192) })).rejects.toMatchObject({
      column: 'InAppNotification.recipientId',
    })
    expect(rows).toHaveLength(1)
  })

  it('a body over TEXT (65 535 bytes) is refused, not cut', async () => {
    const { client, rows } = mysqlLikeClient()
    const store = new PrismaInAppStore(client, { columnLimits: 'mysql' })
    await expect(store.append({ ...n, body: 'b'.repeat(65_536) })).rejects.toBeInstanceOf(ColumnLengthError)
    expect(rows).toHaveLength(0)
  })
})
