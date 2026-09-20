import { beforeEach, describe, expect, it } from 'vitest'
import { SqliteUserSource, openAuthDatabase } from '../src/index.js'

/** BK-022: bulk contact lookup over one `IN (…)` query, chunked, hash-free. */
describe('SqliteUserSource.findByIds', () => {
  let db: ReturnType<typeof openAuthDatabase>
  let source: SqliteUserSource

  beforeEach(() => {
    db = openAuthDatabase(':memory:')
    source = new SqliteUserSource(db)
  })

  const seed = async (n: number) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const u = await source.create({ email: `u${i}@acme.test`, passwordHash: `hash-${i}` })
      ids.push(u.id)
    }
    return ids
  }

  it('returns the contacts in the order of the requested ids', async () => {
    const ids = await seed(3)
    const found = await source.findByIds([ids[2]!, ids[0]!, ids[1]!])
    expect(found.map((u) => u.email)).toEqual(['u2@acme.test', 'u0@acme.test', 'u1@acme.test'])
  })

  it('omits ids with no account and de-duplicates repeats', async () => {
    const ids = await seed(2)
    expect((await source.findByIds([ids[0]!, 'ghost', ids[0]!])).map((u) => u.id)).toEqual([ids[0]])
    expect(await source.findByIds([])).toEqual([])
  })

  it('never returns a password hash', async () => {
    const ids = await seed(1)
    const found = await source.findByIds(ids)
    expect(Object.keys(found[0]!).sort()).toEqual(['email', 'emailVerified', 'id'])
    expect(JSON.stringify(found)).not.toContain('hash-0')
  })

  it('reports verification state', async () => {
    const ids = await seed(2)
    await source.update(ids[1]!, { emailVerified: true })
    const found = await source.findByIds(ids)
    expect(found.map((u) => u.emailVerified)).toEqual([false, true])
  })

  it('chunks a long id list (SQLite caps bound variables per statement)', async () => {
    const ids = await seed(7)
    const chunked = new SqliteUserSource(db, { idChunkSize: 2 })
    expect((await chunked.findByIds(ids)).map((u) => u.id)).toEqual(ids)

    // A list far past the historical 999-variable limit still resolves.
    const many = [...ids, ...Array.from({ length: 2000 }, (_, i) => `ghost-${i}`)]
    expect((await source.findByIds(many)).map((u) => u.id)).toEqual(ids)
  })
})
