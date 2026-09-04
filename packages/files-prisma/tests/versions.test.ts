import { describe, expect, it } from 'vitest'
import { PrismaFileVersionStore, type PrismaFileVersionsClient } from '../src/versions.js'

/**
 * A1 · the durable half of `@basaltkit/files-versions`.
 *
 * Shipping the version store with a memory default only would repeat the very
 * asymmetry `files-prisma` exists to close: the history dies on restart and the
 * files outlive it, leaving every past draft on the disk with nothing left to
 * say which document it belonged to.
 */

interface VRow {
  tenantId: string
  groupId: string
  fileId: string
  version: number
  note: string | null
  by: string | null
  createdAt: Date
}

function fakeClient(): PrismaFileVersionsClient & { rows: VRow[] } {
  const rows: VRow[] = []
  const filtra = (where: Partial<VRow>): VRow[] =>
    rows.filter((r) => Object.entries(where).every(([k, v]) => r[k as keyof VRow] === v))
  return {
    rows,
    fileVersion: {
      async findFirst({ where, orderBy }) {
        const out = filtra(where)
        if (orderBy?.version === 'desc') out.sort((a, b) => b.version - a.version)
        return out[0] ?? null
      },
      async findMany({ where, orderBy }) {
        const out = filtra(where)
        if (orderBy?.version === 'desc') out.sort((a, b) => b.version - a.version)
        return out
      },
      async create({ data }) {
        // The composite primary key, enforced: this is the whole reason the
        // read-then-insert in `append` is safe.
        const chave = (r: { tenantId: string; groupId: string; version: number }): string =>
          `${r.tenantId}::${r.groupId}::${r.version}`
        if (rows.some((r) => chave(r) === chave(data))) {
          throw new Error('Unique constraint failed on the fields: (tenantId, groupId, version)')
        }
        rows.push({ ...data } as VRow)
        return data as VRow
      },
    },
  }
}

describe('F-28 · PrismaFileVersionStore', () => {
  it('numbers revisions and reads them back newest first', async () => {
    const store = new PrismaFileVersionStore(fakeClient())

    await store.append('acme', 'g1', 'f1', { note: 'primeira minuta', by: 'ana' })
    await store.append('acme', 'g1', 'f2', { note: 'após reunião', by: 'rui' })

    expect((await store.history('acme', 'g1')).map((v) => v.version)).toEqual([2, 1])
    expect((await store.latest('acme', 'g1'))?.note).toBe('após reunião')
    expect((await store.at('acme', 'g1', 1))?.by).toBe('ana')
  })

  it('omits an absent note or author instead of returning null', async () => {
    const store = new PrismaFileVersionStore(fakeClient())
    await store.append('acme', 'g1', 'f1')
    const v = await store.latest('acme', 'g1')
    expect(v).not.toHaveProperty('note')
    expect(v).not.toHaveProperty('by')
  })

  it('numbers each tenant history on its own', async () => {
    const store = new PrismaFileVersionStore(fakeClient())
    await store.append('acme', 'g1', 'f1')
    await store.append('globex', 'g1', 'f2')

    // Same group id, two firms: both hold version 1 of their own document.
    expect((await store.latest('acme', 'g1'))?.version).toBe(1)
    expect((await store.latest('globex', 'g1'))?.version).toBe(1)
    expect(await store.history('acme', 'g1')).toHaveLength(1)
  })

  it('refuses a duplicate revision number rather than accepting both', async () => {
    // The real race: `append` reads the highest version, and a second upload
    // lands *between* that read and the insert. Injecting the competing row
    // before the read would only test that 2 + 1 is 3.
    const client = fakeClient()
    const store = new PrismaFileVersionStore(client)
    await store.append('acme', 'g1', 'f1')

    const original = client.fileVersion.findFirst
    let uma = false
    client.fileVersion.findFirst = async (a) => {
      const r = await original(a)
      if (!uma) {
        uma = true
        client.rows.push({
          tenantId: 'acme',
          groupId: 'g1',
          fileId: 'concorrente',
          version: 2,
          note: null,
          by: null,
          createdAt: new Date(),
        })
      }
      return r
    }

    // The primary key decides: one upload wins, the other fails loudly. For a
    // contract draft a duplicate number is worse than a failed upload — it
    // leaves a history that cannot say which draft is which.
    await expect(store.append('acme', 'g1', 'f2')).rejects.toThrow(/Unique constraint/)
  })
})
