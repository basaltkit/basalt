import { beforeEach, describe, expect, it } from 'vitest'
import type { FileRecord } from '@basaltkit/files'
import { PrismaFileStore, type PrismaFilesClient, prismaFilesStore } from '../src/index.js'

/**
 * A7 · the file domain finally has a durable store.
 *
 * `@basaltkit/files` shipped one implementation, `MemoryFileStore`, and used it
 * as the default. For a cache that is harmless. Here it loses the only link to
 * bytes that still exist: the disk key is `files/<uuid>` and the uuid lived in
 * the process, so a restart leaves every upload in the bucket, unreferenced and
 * unreachable, while the application reports an empty list and nothing errors.
 *
 * The fake client below mirrors what Prisma does with the bundled schema —
 * `BigInt` sizes, `Date` columns, a JSON column and a composite key — because
 * those conversions are the whole substance of this package.
 */

interface FRow {
  tenantId: string
  id: string
  name: string
  contentType: string
  size: bigint
  path: string
  checksum: string
  uploadedBy: string | null
  metadata: unknown
  scannedAt: Date | null
  createdAt: Date
}

function fakeClient(): PrismaFilesClient {
  const rows = new Map<string, FRow>()
  const k = (t: string, i: string): string => `${t}::${i}`
  return {
    file: {
      async findUnique({ where }) {
        const { tenantId, id } = where.tenantId_id
        return rows.get(k(tenantId, id)) ?? null
      },
      async findMany({ where, orderBy }) {
        let out = [...rows.values()].filter((r) => r.tenantId === where.tenantId)
        if (orderBy?.createdAt === 'desc') {
          out = out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return out
      },
      async create({ data }) {
        const row = { ...data } as FRow
        rows.set(k(row.tenantId, row.id), row)
        return row
      },
      async updateMany({ where, data }) {
        const row = rows.get(k(where.tenantId, where.id))
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async deleteMany({ where }) {
        return { count: rows.delete(k(where.tenantId, where.id)) ? 1 : 0 }
      },
      async aggregate({ where }) {
        let total = 0n
        for (const r of rows.values()) if (r.tenantId === where.tenantId) total += r.size
        // Prisma returns null, not 0n, when nothing matched.
        return { _sum: { size: rows.size > 0 ? total : null } }
      },
    },
  }
}

const registo = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: 'f1',
  tenantId: 'acme',
  name: 'contrato.pdf',
  contentType: 'application/pdf',
  size: 2048,
  path: 'files/f1',
  checksum: 'abc',
  createdAt: 1_700_000_000_000,
  ...over,
})

describe('F-27 · PrismaFileStore', () => {
  let store: PrismaFileStore

  beforeEach(() => {
    store = prismaFilesStore(fakeClient()).store
  })

  it('round-trips a record through the database types', async () => {
    await store.create(registo({ uploadedBy: 'u1', metadata: { origem: 'portal' } }))
    const lido = await store.find('acme', 'f1')

    // size returns as a number even though the column is BigInt, and createdAt
    // as epoch ms even though the column is a Date. A store that leaked either
    // would fail at the first `record.size > limit`.
    expect(lido?.size).toBe(2048)
    expect(typeof lido?.size).toBe('number')
    expect(lido?.createdAt).toBe(1_700_000_000_000)
    expect(lido?.metadata).toEqual({ origem: 'portal' })
    expect(lido?.uploadedBy).toBe('u1')
  })

  it('omits absent optionals instead of returning null', async () => {
    await store.create(registo())
    const lido = await store.find('acme', 'f1')
    // The columns are nullable; the contract's fields are optional. Handing back
    // `uploadedBy: null` would satisfy neither the type nor `?? fallback`.
    expect(lido).not.toHaveProperty('uploadedBy')
    expect(lido).not.toHaveProperty('metadata')
    expect(lido).not.toHaveProperty('scannedAt')
  })

  it('never returns another tenant a file', async () => {
    await store.create(registo({ tenantId: 'acme' }))
    await store.create(registo({ tenantId: 'globex', id: 'f2' }))

    expect(await store.find('globex', 'f1')).toBeNull()
    expect((await store.list('acme')).map((f) => f.id)).toEqual(['f1'])
    // A delete aimed at someone else's row must not land, even with the right id.
    await store.delete('globex', 'f1')
    expect(await store.find('acme', 'f1')).not.toBeNull()
  })

  it('lists newest first', async () => {
    await store.create(registo({ id: 'velho', createdAt: 1_000 }))
    await store.create(registo({ id: 'novo', createdAt: 2_000 }))
    expect((await store.list('acme')).map((f) => f.id)).toEqual(['novo', 'velho'])
  })

  it('writes a key present in the patch and leaves an absent one alone', async () => {
    await store.create(registo({ metadata: { origem: 'portal' } }))

    await store.update('acme', 'f1', { scannedAt: 1_700_000_001_000 })
    let lido = await store.find('acme', 'f1')
    expect(lido?.scannedAt).toBe(1_700_000_001_000)
    expect(lido?.metadata).toEqual({ origem: 'portal' })

    // An explicit `undefined` clears the column — that is how a caller drops a
    // stale scan result — while the metadata it did not mention survives.
    await store.update('acme', 'f1', { scannedAt: undefined })
    lido = await store.find('acme', 'f1')
    expect(lido).not.toHaveProperty('scannedAt')
    expect(lido?.metadata).toEqual({ origem: 'portal' })
  })

  it('returns null updating a file that is not there', async () => {
    expect(await store.update('acme', 'inexistente', { scannedAt: 1 })).toBeNull()
  })

  it('sums a tenant quota in the database', async () => {
    await store.create(registo({ id: 'a', size: 1_000 }))
    await store.create(registo({ id: 'b', size: 2_500 }))
    await store.create(registo({ id: 'c', size: 10, tenantId: 'globex' }))

    // Summed by the database rather than by listing and adding up: a quota check
    // runs on every upload, and a tenant with fifty thousand files should not
    // move fifty thousand rows to learn one number.
    expect(await store.totalSize('acme')).toBe(3_500)
    expect(await store.totalSize('globex')).toBe(10)
  })

  it('reports zero for a tenant with nothing stored', async () => {
    // Prisma's aggregate returns null, not 0n, when no row matched.
    expect(await store.totalSize('vazio')).toBe(0)
  })
})
