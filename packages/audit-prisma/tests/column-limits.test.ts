import type { AuditEntry } from '@basaltkit/audit'
import { describe, expect, it } from 'vitest'
import {
  ColumnLengthError,
  PrismaAuditStore,
  type PrismaAuditClient,
  auditMysqlColumnLimits,
  prismaAuditStore,
} from '../src/index.js'

/**
 * A fake that behaves like MySQL outside strict mode: every string column is
 * VARCHAR(191) unless widened, and a longer value is cut — the write succeeds.
 */
function mysqlLikeClient(widths: Record<string, number> = {}): { client: PrismaAuditClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const client: PrismaAuditClient = {
    auditEntry: {
      async create({ data }) {
        const row: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
          row[k] = typeof v === 'string' ? v.slice(0, widths[k] ?? 191) : v
        }
        rows.push(row)
        return row as never
      },
      async findMany() {
        return rows as never
      },
    },
  }
  return { client, rows }
}

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'a1',
  source: 'hook',
  event: 'invoice.created',
  at: 1,
  seq: 1,
  prevHash: '0'.repeat(64),
  hash: 'f'.repeat(64),
  tenantId: 't1',
  payload: undefined,
  ...over,
})

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard a long value is truncated by the database — the failure mode', async () => {
    const { client, rows } = mysqlLikeClient()
    await new PrismaAuditStore(client).append(entry({ payload: { note: 'x'.repeat(500) } }))
    expect((rows[0]!.payload as string).length).toBe(191)
  })

  it("'mysql' refuses a >191 value in a VARCHAR(191) column — nothing is written", async () => {
    const { client, rows } = mysqlLikeClient()
    const store = new PrismaAuditStore(client, { columnLimits: 'mysql' })
    const err = await store.append(entry({ event: 'e'.repeat(192) })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ColumnLengthError)
    expect(err).toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      column: 'AuditEntry.event',
      length: 192,
      limit: 191,
      unit: 'characters',
    })
    expect(rows).toHaveLength(0)
  })

  it('a chained hash too long for its column is refused, not cut (the chain stays verifiable)', async () => {
    const { client, rows } = mysqlLikeClient()
    const store = prismaAuditStore(client, { columnLimits: 'mysql' }).store
    await expect(store.append(entry({ hash: 'h'.repeat(300) }))).rejects.toThrow(/AuditEntry\.hash is 300 characters/)
    expect(rows).toHaveLength(0)
  })

  it('exactly at the limit is accepted; the payload column is sized in bytes', async () => {
    const { client, rows } = mysqlLikeClient({ payload: 16_777_215, userAgent: 65_535 })
    const store = new PrismaAuditStore(client, { columnLimits: 'mysql' })
    await store.append(entry({ event: 'e'.repeat(191), payload: { note: 'x'.repeat(10_000) } }))
    expect(rows).toHaveLength(1)
    // 'é' is 2 bytes: 40 000 of them fit in 65 535 characters but not in TEXT's 65 535 bytes.
    await expect(store.append(entry({ id: 'a2', userAgent: 'é'.repeat(40_000) }))).rejects.toMatchObject({
      column: 'AuditEntry.userAgent',
      length: 80_000,
      limit: 65_535,
      unit: 'bytes',
    })
  })

  it('counts characters, not UTF-16 units, for VARCHAR (MySQL utf8mb4 counts code points)', async () => {
    const { client } = mysqlLikeClient()
    const store = new PrismaAuditStore(client, { columnLimits: 'mysql' })
    // 191 emoji: 382 UTF-16 units, 191 characters — it fits.
    await expect(store.append(entry({ actorId: '😀'.repeat(191) }))).resolves.toBeUndefined()
    await expect(store.append(entry({ id: 'a3', actorId: '😀'.repeat(192) }))).rejects.toBeInstanceOf(ColumnLengthError)
  })

  it('custom limits: a widened column, by spreading the preset', async () => {
    const { client } = mysqlLikeClient({ event: 500 })
    const store = new PrismaAuditStore(client, {
      columnLimits: { AuditEntry: { ...auditMysqlColumnLimits.AuditEntry, event: 500 } },
    })
    await expect(store.append(entry({ event: 'e'.repeat(400) }))).resolves.toBeUndefined()
    await expect(store.append(entry({ id: 'a4', event: 'e'.repeat(501) }))).rejects.toBeInstanceOf(ColumnLengthError)
  })

  it('unset: no check at all (PostgreSQL / SQLite are unaffected)', async () => {
    const rows: unknown[] = []
    const client: PrismaAuditClient = {
      auditEntry: { async create({ data }) { rows.push(data); return data }, async findMany() { return [] } },
    }
    await new PrismaAuditStore(client).append(entry({ event: 'e'.repeat(10_000) }))
    expect(rows).toHaveLength(1)
  })

  it('a malformed limit fails at wiring time', () => {
    const { client } = mysqlLikeClient()
    expect(() => new PrismaAuditStore(client, { columnLimits: { AuditEntry: { event: 0 } } })).toThrow(TypeError)
    expect(() => new PrismaAuditStore(client, { columnLimits: { AuditEntry: { event: { bytes: -1 } } } })).toThrow(TypeError)
    expect(() => new PrismaAuditStore(client, { columnLimits: 'postgres' as never })).toThrow(TypeError)
  })

  it('the error never carries the value (it may be PII or a secret)', async () => {
    const { client } = mysqlLikeClient()
    const store = new PrismaAuditStore(client, { columnLimits: 'mysql' })
    const secret = `sk_live_${'s'.repeat(300)}`
    const err = (await store.append(entry({ requestId: secret })).catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain('sk_live_')
  })
})
