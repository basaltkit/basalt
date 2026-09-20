import { describe, expect, it } from 'vitest'
import { syncConnection, type DriveImportTask, type DriveRemoval } from '@basaltkit/drives'
import { connect, harness } from './helpers.js'

const FILES = [
  { id: '01AAA', name: 'invoice.pdf', content: 'invoice bytes' },
  { id: '01BBB', name: 'report.txt', content: 'report bytes' },
]

function collector() {
  const tasks: DriveImportTask[] = []
  const removals: DriveRemoval[] = []
  return {
    tasks,
    removals,
    enqueue: async (task: DriveImportTask): Promise<void> => void tasks.push(task),
    onRemoved: (removal: DriveRemoval): void => void removals.push(removal),
  }
}

describe('the change feed', () => {
  it('declares `deltaIncludesExisting` and therefore backfills through the feed itself', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    const sink = collector()

    // Graph's `/delta` with no token enumerates the drive and only then hands
    // over a `deltaLink`, so the first sync runs in `delta` mode and still sees
    // everything that already exists. Google's `changes.getStartPageToken` is
    // the opposite, which is why the flag exists at all.
    expect(h.provider.deltaIncludesExisting).toBe(true)
    const result = await syncConnection(h.drives, view.id, { enqueue: sink.enqueue })

    expect(result.mode).toBe('delta')
    expect(sink.tasks.map((t) => t.item.externalId).sort()).toEqual(['01AAA', '01BBB'])
    // The engine did NOT run a separate listing pass first: every call was to
    // the delta endpoint.
    expect(h.graph.requests.some((r) => r.url.includes('/children'))).toBe(false)
    expect(h.graph.requests.some((r) => r.url.includes('/root/delta'))).toBe(true)
  })

  it('persists an opaque cursor and imports only what changed on the next run', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    const first = collector()
    await syncConnection(h.drives, view.id, { enqueue: first.enqueue })

    const stored = (await h.store.find('default', view.id))!.cursor!
    // `@odata.deltaLink` is a complete URL; the connection row holds a wrapper.
    expect(stored).not.toContain('https://')
    expect(stored).toMatch(/^basalt\.msgraph\.delta:/)

    h.graph.put({ id: '01CCC', name: 'contract.pdf', content: 'contract bytes' })
    const second = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: second.enqueue })

    expect(result.mode).toBe('delta')
    expect(second.tasks.map((t) => t.item.externalId)).toEqual(['01CCC'])
  })

  it('reports a deletion by id, so the ledger can resolve what it was', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.graph.remove('01AAA')
    const sink = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: sink.enqueue, onRemoved: sink.onRemoved })

    expect(result.removed).toBe(1)
    // Graph reports the item's own id plus a `deleted` facet. Unlike Dropbox,
    // this adapter never needs the contract's path-only removal shape — and the
    // id is what makes `targetId` resolvable for an app.
    expect(sink.removals).toEqual([
      { tenantId: 'default', connectionId: view.id, externalId: '01AAA' },
    ])
  })

  it('walks several delta pages in one run', async () => {
    const h = harness({ server: { files: FILES, pageSize: 1 } })
    const view = await connect(h)
    const sink = collector()

    const result = await syncConnection(h.drives, view.id, { enqueue: sink.enqueue })

    expect(sink.tasks).toHaveLength(2)
    expect(result.mode).toBe('delta')
    // Every page after the first was fetched from the `@odata.nextLink` the
    // previous one handed back, unwrapped out of the opaque cursor.
    expect(h.graph.requests.filter((r) => r.url.includes('/delta')).length).toBeGreaterThan(1)
  })

  it('drops the cursor and asks to be re-primed on `410 resyncRequired`', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    expect((await h.store.find('default', view.id))!.cursor).toBeDefined()

    // Graph invalidates a delta token that has aged out. The cursor is
    // PERSISTED, so mapping this to anything else would fail every future sync
    // of this connection identically, for ever, with no retry policy able to
    // help.
    h.graph.expireDeltaLinks()
    const sink = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: sink.enqueue })

    expect(result.reset).toBe(true)
    expect(result.truncated).toBe(true)
    expect((await h.store.find('default', view.id))!.cursor).toBeUndefined()

    // The next run re-primes from the beginning and the ledger absorbs the
    // repetition: a reset costs metadata reads, not re-downloads.
    const recovered = collector()
    await syncConnection(h.drives, view.id, { enqueue: recovered.enqueue })
    expect(recovered.tasks.map((t) => t.item.externalId).sort()).toEqual(['01AAA', '01BBB'])
  })

  it('refuses a delta cursor that was not produced by this adapter', async () => {
    const h = harness({ server: { files: FILES } })
    const view = await connect(h)

    await expect(h.provider.delta(sessionOf(h, view.id), 'cur:2')).rejects.toMatchObject({
      code: 'DRIVE_ACCESS_DENIED',
    })
  })
})

describe('rate limits', () => {
  it('honours Graph’s Retry-After and succeeds on the retry', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    // Graph always sends `Retry-After` with a throttle, which is why this
    // adapter declares no `retryAfterFromBody` — a parser that could only ever
    // return `undefined` would make the guard read a body it is right to
    // destroy.
    expect((h.provider as { retryAfterFromBody?: unknown }).retryAfterFromBody).toBeUndefined()
    h.graph.queue(429, JSON.stringify({ error: { code: 'activityLimitReached' } }), { 'retry-after': '1' })

    await expect(h.drives.listItems(view.id)).resolves.toBeDefined()
  })
})

/** A session shaped the way the engine builds one, for a direct adapter call. */
function sessionOf(h: ReturnType<typeof harness>, connectionId: string) {
  return {
    accessToken: 'access-1',
    connectionId,
    tenantId: 'default',
    fetch: async () => {
      throw new Error('the cursor must be refused before any fetch')
    },
  } as never
}
