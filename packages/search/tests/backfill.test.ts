import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { SEARCH, searchPlugin, syncRule } from '../src/index.js'
import { MemorySearchDriver } from '../src/memory.js'

/**
 * B21 · an index only knew what was created after it existed.
 *
 * `syncRule` keeps an index current from the moment the rule is registered, and
 * does nothing for the rows already in the database. The package had `clear()`
 * and `bulk()` but nothing that walks the data: the loop over the tables, the
 * mapping to documents and the paging all belonged to the application, which
 * then had to repeat **exactly** what its `syncRule`s already declared.
 *
 * The defect that invites is quiet. Let the reindex command and the rules drift
 * apart, and the same search returns different things depending on whether a
 * record predates the last rebuild.
 *
 * And the failure it causes is worse than having no search: an application that
 * adds search to existing data gets a box that returns nothing for everything
 * old, and an empty result is indistinguishable from "there is none".
 */

interface Matter {
  id: string
  number: string
}

const ALL: Matter[] = [
  { id: 'm1', number: '2026/001' },
  { id: 'm2', number: '2026/002' },
  { id: 'm3', number: '2026/003' },
]

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'matter:opened': { matter: Matter }
  }
}

/**
 * Pages the way a real repository would, so the loop is exercised.
 *
 * It yields **hook payloads**, not rows — which is what lets one `document`
 * function serve both directions. Yielding rows would need a second mapping,
 * and a second mapping is the drift this exists to prevent.
 */
async function* pages(size: number): AsyncGenerator<Array<{ matter: Matter }>> {
  for (let i = 0; i < ALL.length; i += size) {
    yield ALL.slice(i, i + size).map((matter) => ({ matter }))
  }
}

const rule = (backfill?: () => AsyncGenerator<Array<{ matter: Matter }>>) =>
  syncRule({
    hook: 'matter:opened',
    index: 'matters',
    document: ({ matter }) => ({ id: matter.id, tenantId: 'acme', number: matter.number }),
    ...(backfill ? { backfill } : {}),
  })

const boot = (rules: ReturnType<typeof syncRule>[]) =>
  createApp({
    plugins: [searchPlugin({ driver: new MemorySearchDriver(), sync: rules })],
  }).boot()

describe('F-36 · reindex from the rules', () => {
  it('indexes what already existed, through the rule that keeps it current', async () => {
    const app = await boot([rule(() => pages(2))])
    const search = app.container.get(SEARCH)

    // Nothing yet: the rule has fired for no event.
    expect((await search.search('matters', '2026', { tenantId: 'acme' })).hits).toHaveLength(0)

    const indexed = await search.reindex('matters')

    expect(indexed).toBe(3)
    expect((await search.search('matters', '2026', { tenantId: 'acme' })).hits).toHaveLength(3)
    await app.shutdown()
  })

  it('builds the same document the event path builds', async () => {
    // The point of putting `backfill` on the rule: one `document` function, so
    // a record cannot be described one way when it is created and another way
    // when it is rebuilt.
    const app = await boot([rule(() => pages(3))])
    const search = app.container.get(SEARCH)

    await app.hooks.emit('matter:opened', { matter: ALL[0]! })
    const fromEvent = (await search.search('matters', '2026/001', { tenantId: 'acme' })).hits[0]

    await search.reindex('matters')
    const fromBackfill = (await search.search('matters', '2026/001', { tenantId: 'acme' })).hits[0]

    expect(fromBackfill?.document).toEqual(fromEvent?.document)
    await app.shutdown()
  })

  it('replaces the index rather than adding to it', async () => {
    const app = await boot([rule(() => pages(2))])
    const search = app.container.get(SEARCH)

    await search.reindex('matters')
    await search.reindex('matters')

    // Twice must not mean six. A rebuild that appends leaves rows for records
    // that no longer exist, which is the state a rebuild exists to end.
    expect((await search.search('matters', '2026', { tenantId: 'acme' })).total).toBe(3)
    await app.shutdown()
  })

  it('refuses an index with no rule that can rebuild it', async () => {
    // Silence here would be the worst answer: the caller would believe the
    // index was rebuilt and search would keep returning nothing for old rows.
    const app = await boot([rule()])
    await expect(app.container.get(SEARCH).reindex('matters')).rejects.toThrow(/backfill/i)
    await app.shutdown()
  })

  it('refuses an index nothing declares at all', async () => {
    const app = await boot([])
    await expect(app.container.get(SEARCH).reindex('nowhere')).rejects.toThrow(/nowhere/)
    await app.shutdown()
  })
})
