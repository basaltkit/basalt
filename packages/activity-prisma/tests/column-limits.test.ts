import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaActivityStore, type PrismaActivityClient, prismaActivityStore } from '../src/index.js'

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
function mysqlLikeClient(): { client: PrismaActivityClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const client: PrismaActivityClient = {
    activityRecord: {
      async create({ data }) {
        rows.push(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v])))
        return data
      },
      async findMany() {
        return []
      },
    },
  }
  return { client, rows }
}

const r = { id: 'a1', log: 'default', description: 'updated the invoice', at: 1 }

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard long properties are cut and stop being JSON', async () => {
    const { client, rows } = mysqlLikeClient()
    await new PrismaActivityStore(client).append({ ...r, properties: { diff: 'x'.repeat(300) } })
    expect(() => JSON.parse(rows[0]!.properties as string)).toThrow()
  })

  it("'mysql' stores long description/properties and refuses a >191 subjectId", async () => {
    const { client, rows } = mysqlLikeClient()
    const { store } = prismaActivityStore(client, { columnLimits: 'mysql' })
    await store.append({ ...r, description: 'd'.repeat(2000), properties: { diff: 'x'.repeat(300) } })
    const err = await store.append({ ...r, id: 'a2', subjectId: 's'.repeat(192) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ColumnLengthError)
    expect(err).toMatchObject({ column: 'ActivityRecord.subjectId', length: 192, limit: 191 })
    expect(rows).toHaveLength(1)
  })
})
