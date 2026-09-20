import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaUserSource, type PrismaAuthClient } from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

/**
 * BK-022: the bulk contact lookup must be ONE `IN (…)` query (chunked, so a
 * huge id list can't blow the driver's bind-parameter limit) and must never
 * select a credential column.
 */
describe('PrismaUserSource.findByIds', () => {
  let client: PrismaAuthClient
  let calls: Array<Record<string, unknown>>

  beforeEach(() => {
    client = makeFakeClient()
    calls = []
    const inner = client.authUser.findMany.bind(client.authUser)
    client.authUser.findMany = async (args: Record<string, unknown>) => {
      calls.push(args)
      return inner(args)
    }
  })

  const seed = async (n: number) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const u = await new PrismaUserSource(client).create({ email: `u${i}@acme.test`, passwordHash: `hash-${i}` })
      ids.push(u.id)
    }
    return ids
  }

  it('reads every user in a single query', async () => {
    const source = new PrismaUserSource(client)
    const ids = await seed(3)

    const found = await source.findByIds(ids)

    expect(calls).toHaveLength(1)
    expect(found.map((u) => u.email)).toEqual(['u0@acme.test', 'u1@acme.test', 'u2@acme.test'])
  })

  it('selects only the non-credential columns', async () => {
    const source = new PrismaUserSource(client)
    const ids = await seed(1)

    const found = await source.findByIds(ids)

    expect(calls[0]?.['select']).toEqual({ id: true, email: true, emailVerified: true })
    expect(Object.keys(found[0]!).sort()).toEqual(['email', 'emailVerified', 'id'])
    expect(JSON.stringify(found)).not.toContain('hash-0')
  })

  it('chunks a long id list instead of sending one oversized IN (…)', async () => {
    const source = new PrismaUserSource(client, { idChunkSize: 2 })
    const ids = await seed(5)

    const found = await source.findByIds(ids)

    expect(calls).toHaveLength(3)
    expect(calls.map((c) => ((c['where'] as { id: { in: string[] } }).id.in.length))).toEqual([2, 2, 1])
    // Chunking is invisible in the result: still one row per id, in order.
    expect(found.map((u) => u.email)).toEqual(ids.map((_, i) => `u${i}@acme.test`))
  })

  it('defaults to a chunk size well inside every driver bind-parameter limit', async () => {
    const source = new PrismaUserSource(client)
    const ids = Array.from({ length: 1200 }, (_, i) => `missing-${i}`)

    await source.findByIds(ids)

    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) {
      expect((c['where'] as { id: { in: string[] } }).id.in.length).toBeLessThanOrEqual(1000)
    }
  })

  it('returns the found users in the order of the requested ids, skipping the missing', async () => {
    const source = new PrismaUserSource(client)
    const ids = await seed(3)

    const found = await source.findByIds([ids[2]!, 'ghost', ids[0]!])
    expect(found.map((u) => u.id)).toEqual([ids[2], ids[0]])
  })

  it('de-duplicates ids and short-circuits an empty list', async () => {
    const source = new PrismaUserSource(client)
    const ids = await seed(1)

    expect(await source.findByIds([ids[0]!, ids[0]!])).toHaveLength(1)
    expect(await source.findByIds([])).toEqual([])
    expect(calls).toHaveLength(1)
  })
})
