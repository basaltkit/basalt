import type { FileRecord } from '@basaltkit/files'
import { describe, expect, it } from 'vitest'
import { ColumnLengthError, PrismaFileStore, type PrismaFilesClient, prismaFilesStore } from '../src/index.js'
import { type PrismaFileVersionsClient, prismaFileVersionsStore } from '../src/versions.js'

/** A MySQL-outside-strict-mode fake: every string column is VARCHAR(191) and a longer value is cut. */
const cut = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 191) : v]))

function filesClient(): { client: PrismaFilesClient; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = []
  const client = {
    file: {
      async create({ data }: { data: Record<string, unknown> }) {
        rows.push(cut(data))
        return data
      },
      async findUnique() {
        return null
      },
      async findMany() {
        return []
      },
      async updateMany() {
        return { count: 0 }
      },
      async deleteMany() {
        return { count: 0 }
      },
      async aggregate() {
        return { _sum: { size: null } }
      },
    },
  } as unknown as PrismaFilesClient
  return { client, rows }
}

const record = (over: Partial<FileRecord> = {}): FileRecord => ({
  id: 'f1',
  tenantId: 't1',
  name: 'contract.pdf',
  contentType: 'application/pdf',
  size: 10,
  path: 'files/f1',
  checksum: 'c'.repeat(64),
  createdAt: 1,
  ...over,
})

const deepPath = `tenants/t1/matters/${'m'.repeat(250)}/contract.pdf`

describe('columnLimits (FA-070: MySQL silently truncates)', () => {
  it('without the guard a long path is cut — the row no longer names the object', async () => {
    const { client, rows } = filesClient()
    await new PrismaFileStore(client).create(record({ path: deepPath }))
    expect(rows[0]!.path).not.toBe(deepPath)
  })

  it("'mysql' stores a long path/name (TEXT) and refuses a >255 content type (VARCHAR(255))", async () => {
    const { client, rows } = filesClient()
    const { store } = prismaFilesStore(client, { columnLimits: 'mysql' })
    await store.create(record({ path: deepPath, name: `${'n'.repeat(400)}.pdf` }))
    expect(rows).toHaveLength(1)
    await expect(store.create(record({ id: 'f2', contentType: `x/${'y'.repeat(260)}` }))).rejects.toMatchObject({
      column: 'File.contentType',
      limit: 255,
    })
    expect(rows).toHaveLength(1)
  })

  it('a custom VARCHAR(191) path is refused rather than orphaning the bytes', async () => {
    const { client, rows } = filesClient()
    const store = new PrismaFileStore(client, { columnLimits: { File: { path: 191 } } })
    await expect(store.create(record({ path: deepPath }))).rejects.toBeInstanceOf(ColumnLengthError)
    expect(rows).toHaveLength(0)
  })

  it('the version store checks FileVersion columns before reading or writing', async () => {
    const calls: string[] = []
    const client: PrismaFileVersionsClient = {
      fileVersion: {
        async findFirst() {
          calls.push('findFirst')
          return null
        },
        async findMany() {
          return []
        },
        async create({ data }) {
          calls.push('create')
          return data
        },
      },
    }
    const { store } = prismaFileVersionsStore(client, { columnLimits: 'mysql' })
    await expect(store.append('t1', 'g'.repeat(192), 'f1')).rejects.toMatchObject({ column: 'FileVersion.groupId' })
    expect(calls).toEqual([])
    await store.append('t1', 'g1', 'f1', { note: 'n'.repeat(5000) })
    expect(calls).toEqual(['findFirst', 'create'])
  })
})
