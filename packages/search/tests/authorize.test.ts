import { describe, expect, it, vi } from 'vitest'
import { Search } from '../src/search.js'
import type { SearchDriver, SearchHit, SearchQuery, SearchResult } from '../src/types.js'

/**
 * B20 · search was the one surface with no answer for row-level authorization.
 *
 * The driver filters by the fields declared `filterable`, and nothing else.
 * There is no per-hit hook and no notion of an actor, so in a product where
 * visibility depends on a policy — a confidential matter is visible only to the
 * people assigned to it — search was the single place the package left unsolved.
 *
 * Both ways out were bad. Denormalising the ACL into the index is fast, and
 * makes the index the second copy of an access rule: removing someone from a
 * confidential matter changes the database and not the index, and search keeps
 * showing it to them until somebody reindexes. **A stale index gives an old
 * result; a stale ACL gives an unauthorized one.** Over-fetching and trimming
 * afterwards — what the application ended up doing — is correct, but the
 * over-fetch factor is a guess and someone with little access gets short pages.
 *
 * `authorize` runs after the driver and before the page is returned, which is
 * what lets the package keep asking until the page is full.
 */

/** A driver over a fixed list, so paging behaviour is exactly predictable. */
function driverOver(ids: string[]): SearchDriver & { calls: SearchQuery[] } {
  const calls: SearchQuery[] = []
  return {
    calls,
    async index() {},
    async remove() {},
    async bulk() {},
    async clear() {},
    async search(_index: string, query: SearchQuery): Promise<SearchResult> {
      calls.push(query)
      const offset = query.offset ?? 0
      const limit = query.limit ?? 10
      const hits: SearchHit[] = ids
        .slice(offset, offset + limit)
        .map((id) => ({ id, score: 1, document: { id, tenantId: 'acme' } }))
      return { hits, total: ids.length }
    },
  }
}

const ids = (n: number, prefix = 'd'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

const search = (driver: SearchDriver) => new Search({ driver })

describe('F-35 · authorize', () => {
  it('passes straight through when there is no hook', async () => {
    const driver = driverOver(ids(5))
    const result = await search(driver).search('docs', 'q', { tenantId: 'acme', limit: 3 })

    expect(result.hits.map((h) => h.id)).toEqual(['d1', 'd2', 'd3'])
    expect(result.total).toBe(5)
    // One call, unchanged behaviour: adding the option must cost nothing to
    // everyone who does not use it.
    expect(driver.calls).toHaveLength(1)
  })

  it('fills the page instead of returning what is left of it', async () => {
    // Every third document is readable. Asking the driver once for 3 would
    // return one row — which is the short page the application had to live
    // with, and the reason the over-fetch factor was a guess.
    const driver = driverOver(ids(30))
    const readable = (h: SearchHit) => Number(h.id.slice(1)) % 3 === 0

    const result = await search(driver).search('docs', 'q', {
      tenantId: 'acme',
      limit: 3,
      authorize: (hits) => hits.filter(readable),
    })

    // A full page of three, not the one row a naive `limit: 3` would have
    // returned. The mechanism is scanning past the page size, which is what a
    // caller cannot do from outside without guessing a factor.
    expect(result.hits.map((h) => h.id)).toEqual(['d3', 'd6', 'd9'])
    const scanned = driver.calls.reduce((n, call) => n + (call.limit ?? 0), 0)
    expect(scanned).toBeGreaterThan(3)
  })

  it('offsets by authorized hits, not by driver rows', async () => {
    // The second page must continue where the first ended. Offsetting the
    // driver instead would skip rows the caller never saw.
    const driver = driverOver(ids(30))
    const readable = (h: SearchHit) => Number(h.id.slice(1)) % 3 === 0
    const authorize = (hits: SearchHit[]) => hits.filter(readable)

    const first = await search(driver).search('docs', 'q', { tenantId: 'acme', limit: 3, authorize })
    const second = await search(driverOver(ids(30))).search('docs', 'q', {
      tenantId: 'acme',
      limit: 3,
      offset: 3,
      authorize,
    })

    expect(first.hits.map((h) => h.id)).toEqual(['d3', 'd6', 'd9'])
    expect(second.hits.map((h) => h.id)).toEqual(['d12', 'd15', 'd18'])
  })

  it('stops at the end of the index rather than looping', async () => {
    const driver = driverOver(ids(10))
    const result = await search(driver).search('docs', 'q', {
      tenantId: 'acme',
      limit: 20,
      authorize: (hits) => hits.filter((h) => h.id === 'd7'),
    })

    expect(result.hits.map((h) => h.id)).toEqual(['d7'])
    // Exhausted, so the count is the truth and not a lower bound.
    expect(result.total).toBe(1)
    expect(result.totalExact).toBe(true)
  })

  it('reports a lower bound rather than a number it cannot stand behind', async () => {
    // A `total` from the driver counts rows the caller may not see. Returning
    // it would render "42 results" above three rows.
    const driver = driverOver(ids(500))
    const result = await search(driver).search('docs', 'q', {
      tenantId: 'acme',
      limit: 2,
      maxScan: 20,
      authorize: (hits) => hits.filter((h) => h.id === 'd400'),
    })

    expect(result.hits).toEqual([])
    expect(result.total).toBe(0)
    expect(result.totalExact).toBe(false)
  })

  it('never asks the driver for more than the scan budget', async () => {
    const driver = driverOver(ids(1000))
    await search(driver).search('docs', 'q', {
      tenantId: 'acme',
      limit: 5,
      maxScan: 50,
      authorize: () => [],
    })

    const scanned = driver.calls.reduce((n, call) => n + (call.limit ?? 0), 0)
    // A hook that authorizes nothing must not walk the whole index.
    expect(scanned).toBeLessThanOrEqual(50)
  })

  it('awaits an async hook', async () => {
    const driver = driverOver(ids(6))
    const authorize = vi.fn(async (hits: SearchHit[]) => hits.filter((h) => h.id !== 'd1'))

    const result = await search(driver).search('docs', 'q', { tenantId: 'acme', limit: 2, authorize })
    expect(result.hits.map((h) => h.id)).toEqual(['d2', 'd3'])
    expect(authorize).toHaveBeenCalled()
  })

  it('keeps the order the driver returned', async () => {
    // Relevance order is the driver's to decide. A hook that reorders would
    // quietly replace ranking with whatever the filter happened to do.
    const driver = driverOver(['b', 'a', 'c'])
    const result = await search(driver).search('docs', 'q', {
      tenantId: 'acme',
      authorize: (hits) => hits,
    })
    expect(result.hits.map((h) => h.id)).toEqual(['b', 'a', 'c'])
  })
})
