import { describe, expect, it } from 'vitest'
import { ColumnLengthError, type PrismaEventsClient, PrismaOutboxStore, prismaOutboxStore } from '../src/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function recordingClient(): { client: PrismaEventsClient; calls: { op: string; args: any }[] } {
  const calls: { op: string; args: any }[] = []
  const client: PrismaEventsClient = {
    outboxEntry: {
      async upsert(args) {
        calls.push({ op: 'upsert', args })
        return args.create
      },
      async findMany() {
        return []
      },
      async updateMany(args) {
        calls.push({ op: 'updateMany', args })
        return { count: 1 }
      },
    },
  }
  return { client, calls }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it("'mysql' enqueues a large payload (MEDIUMTEXT) and refuses a >191 event name", async () => {
    const { client, calls } = recordingClient()
    const { store } = prismaOutboxStore(client, { columnLimits: 'mysql' })
    await store.enqueue({ event: 'order.created', payload: { lines: 'x'.repeat(100_000) }, createdAt: 1 })
    await expect(store.enqueue({ event: 'e'.repeat(192), payload: null, createdAt: 1 })).rejects.toMatchObject({
      code: 'COLUMN_LENGTH_EXCEEDED',
      column: 'OutboxEntry.event',
    })
    expect(calls.map((c) => c.op)).toEqual(['upsert'])
  })

  it('a payload over a custom limit is refused inside the caller transaction (before the write)', async () => {
    const { client } = recordingClient()
    const tx = recordingClient()
    const store = new PrismaOutboxStore(client, { columnLimits: { OutboxEntry: { payload: 191 } } })
    await expect(
      store.enqueue({ event: 'a', payload: { big: 'x'.repeat(300) }, createdAt: 1 }, { tx: tx.client }),
    ).rejects.toBeInstanceOf(ColumnLengthError)
    expect(tx.calls).toEqual([])
  })

  it('markFailed still counts the attempt: an over-long lastError is shortened on purpose, not refused', async () => {
    const { client, calls } = recordingClient()
    const store = new PrismaOutboxStore(client, { columnLimits: { OutboxEntry: { lastError: 191 } } })
    await store.markFailed('id1', 'E'.repeat(5000))
    const data = calls[0]!.args.data
    expect(data.attempts).toEqual({ increment: 1 })
    expect([...data.lastError].length).toBe(191)
    expect(data.lastError.endsWith('…[truncated]')).toBe(true)
  })

  it("'mysql' clips lastError by UTF-8 bytes (TEXT is 65 535 bytes)", async () => {
    const { client, calls } = recordingClient()
    const store = new PrismaOutboxStore(client, { columnLimits: 'mysql' })
    await store.markFailed('id1', '€'.repeat(30_000)) // 90 000 bytes
    expect(Buffer.byteLength(calls[0]!.args.data.lastError, 'utf8')).toBeLessThanOrEqual(65_535)
    await store.markFailed('id2', 'short')
    expect(calls[1]!.args.data.lastError).toBe('short')
  })

  it('unset: no check, no clipping (PostgreSQL / SQLite)', async () => {
    const { client, calls } = recordingClient()
    const store = new PrismaOutboxStore(client)
    await store.enqueue({ event: 'e'.repeat(500), payload: null, createdAt: 1 })
    await store.markFailed('id1', 'E'.repeat(5000))
    expect(calls[1]!.args.data.lastError).toHaveLength(5000)
  })
})
