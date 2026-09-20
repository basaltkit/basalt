import { describe, expect, it } from 'vitest'
import { syncConnection, type DriveImportTask, type DriveRemoval } from '@basaltkit/drives'
import { FOLDER_MIME } from './google-server.js'
import { connect, harness } from './helpers.js'

const TREE = [
  { id: 'root-folder', name: 'Finance', mimeType: FOLDER_MIME, parents: [] },
  { id: 'sub-folder', name: '2026', mimeType: FOLDER_MIME, parents: ['root-folder'] },
  { id: 'top', name: 'summary.pdf', content: 'summary', parents: ['root-folder'] },
  { id: 'deep', name: 'invoice.pdf', content: 'invoice', parents: ['sub-folder'] },
  { id: 'elsewhere', name: 'private.pdf', content: 'private', parents: ['other-folder'] },
]

function collector() {
  const tasks: DriveImportTask[] = []
  const removals: DriveRemoval[] = []
  return {
    tasks,
    removals,
    ids: (): string[] => tasks.map((t) => t.item.externalId).sort(),
    enqueue: async (task: DriveImportTask) => void tasks.push(task),
    onRemoved: (removal: DriveRemoval) => void removals.push(removal),
  }
}

describe('the first sync — the one `deltaIncludesExisting: false` exists for', () => {
  it('backfills the existing corpus with a listing pass, then follows the change feed', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    const first = collector()

    const result = await syncConnection(h.drives, view.id, { enqueue: first.enqueue })

    // `changes.getStartPageToken` is explicitly "from now on": the corpus that
    // already exists never appears in `changes.list`. So the engine takes the
    // token first and then *lists*.
    expect(result.mode).toBe('listing')
    expect(first.ids()).toEqual(['deep', 'elsewhere', 'top'])
    // The primed token was persisted, so the next run is incremental.
    expect((await h.store.find('default', view.id))!.cursor).toBeTruthy()

    h.google.put({ id: 'new', name: 'new.pdf', content: 'new', parents: ['root-folder'] })
    const second = collector()
    const incremental = await syncConnection(h.drives, view.id, { enqueue: second.enqueue })

    expect(incremental.mode).toBe('delta')
    expect(second.ids()).toEqual(['new'])
  })

  it('would import NOTHING if the adapter claimed the feed replays what exists', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    // The single mistake this flag prevents, made on purpose. An adapter that
    // copied Dropbox's `true` here reports a successful first sync, imports not
    // one file, and persists a cursor that guarantees the existing corpus is
    // never seen again — silently, for the life of the connection.
    Object.defineProperty(h.provider, 'deltaIncludesExisting', { value: true })
    const view = await connect(h)
    const tasks = collector()

    const result = await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue })

    expect(result.mode).toBe('delta')
    expect(result.enqueued).toBe(0)
    expect(h.provider.deltaIncludesExisting).toBe(true)
  })

  it('declares the flag that makes the engine backfill', () => {
    const h = harness()
    expect(h.provider.deltaIncludesExisting).toBe(false)
  })

  it('never downloads during a sync', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    expect(h.google.requests.some((r) => r.url.includes('alt=media'))).toBe(false)
  })
})

describe('a root-scoped connection over an account-wide feed', () => {
  it('backfills only the subtree', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    const tasks = collector()

    await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue })

    expect(tasks.ids()).toEqual(['deep', 'top'])
  })

  it('filters the change feed client-side, because changes.list has no folder scope', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.google.edit('deep', 'invoice v2')
    h.google.edit('elsewhere', 'private v2')
    const tasks = collector()
    await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue })

    // `deep` is two levels down and still in scope; `elsewhere` lives in
    // another folder of the same account and must never appear.
    expect(tasks.ids()).toEqual(['deep'])
    // The request really was account-wide — there is no folder parameter to
    // send, which is exactly why the filtering has to happen here.
    const changes = h.google.requests.filter((r) => r.url.includes('/drive/v3/changes?')).at(-1)!
    const params = new URL(changes.url).searchParams
    expect(params.get('pageToken')).toBeTruthy()
    expect(params.has('folderId')).toBe(false)
    expect(params.has('q')).toBe(false)
  })

  it('keeps an out-of-scope item out of the task entirely, not just out of the sink', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    h.google.edit('elsewhere', 'private v2')

    const tasks = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue, onRemoved: tasks.onRemoved })

    // Dropped before it becomes a `DriveChange`, so it reaches neither the
    // hooks, nor `onRemoved`, nor a ledger lookup. `seen` counts what the
    // engine was told about, and it was told about nothing.
    expect(result.seen).toBe(0)
    expect(tasks.tasks).toHaveLength(0)
    expect(tasks.removals).toHaveLength(0)
  })

  it('caches ancestry within one delta call', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.google.edit('deep', 'v2')
    h.google.put({ id: 'deep2', name: 'other.pdf', content: 'x', parents: ['sub-folder'] })
    const before = h.google.requests.length
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    // Both changes share a parent, so the scope check costs ONE metadata read,
    // not one per change. The cache lives for exactly one call, so it can never
    // carry an answer from one connection into another.
    const lookups = h.google.requests
      .slice(before)
      .filter((r) => /\/drive\/v3\/files\/[^?]+\?fields=id(,|%2C)parents/.test(r.url))
    expect(lookups).toHaveLength(1)
  })

  it('refuses to spend an unbounded number of metadata reads on ancestry', async () => {
    const h = harness({
      server: { files: TREE, pageSize: 50 },
      provider: { ancestryMaxLookups: 0 },
    })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    h.google.edit('deep', 'v2')

    // Loud rather than silent: guessing "in scope" leaks another folder's
    // metadata and guessing "out of scope" loses a tenant's file, so the run
    // fails and `ancestryMaxLookups` is the knob.
    await expect(syncConnection(h.drives, view.id, { enqueue: collector().enqueue })).rejects.toMatchObject({
      code: 'DRIVE_PROVIDER_ERROR',
    })
  })
})

describe('removals', () => {
  it('reports a trashed file by id, because Drive still hands over the resource', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.google.trash('deep')
    const tasks = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue, onRemoved: tasks.onRemoved })

    expect(result.removed).toBe(1)
    // Google reports deletions by id, so — unlike Dropbox — the path shape of
    // `DriveChange` is not needed here at all.
    expect(tasks.removals[0]!.externalId).toBe('deep')
    expect(tasks.removals[0]!.path).toBeUndefined()
  })

  it('reports a hard deletion on an unscoped connection', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.google.remove('top')
    const tasks = collector()
    await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue, onRemoved: tasks.onRemoved })

    expect(tasks.removals.map((r) => r.externalId)).toEqual(['top'])
  })

  it('drops an unscopable hard deletion on a scoped connection, rather than leaking an id', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    // `{fileId, removed: true}` and NO file resource: there is nothing left to
    // test the ancestry of, so forwarding it would put an id from outside the
    // connection's folder into `onRemoved` and the app's hooks.
    h.google.remove('elsewhere')
    const tasks = collector()
    const result = await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue, onRemoved: tasks.onRemoved })

    expect(result.removed).toBe(0)
    expect(tasks.removals).toHaveLength(0)
  })

  it('forwards unscopable deletions when the app opts in', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 }, provider: { includeUnscopedRemovals: true } })
    const view = await connect(h, { rootId: 'root-folder' })
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    h.google.remove('deep')
    const tasks = collector()
    await syncConnection(h.drives, view.id, { enqueue: tasks.enqueue, onRemoved: tasks.onRemoved })

    // Opting in means the app takes on the correlation: the ledger knows which
    // ids it imported, and the adapter does not.
    expect(tasks.removals.map((r) => r.externalId)).toEqual(['deep'])
  })
})

describe('a dead page token', () => {
  it('restarts the feed instead of failing identically for ever', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    expect((await h.store.find('default', view.id))!.cursor).toBeTruthy()

    // Google has no distinct code for an expired token — it is simply an
    // invalid value — so only a call that actually carried a cursor may read a
    // `400 invalid` as a dead cursor.
    h.google.expireCursors()
    const result = await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })

    expect(result.reset).toBe(true)
    expect(result.truncated).toBe(true)
    // The cursor is PERSISTED: anything but dropping it makes every future sync
    // of this connection fail the same way, with no retry policy able to help.
    expect((await h.store.find('default', view.id))!.cursor).toBeUndefined()

    const after = collector()
    const rerun = await syncConnection(h.drives, view.id, { enqueue: after.enqueue })
    expect(rerun.mode).toBe('listing')
    expect(after.ids()).toEqual(['deep', 'elsewhere', 'top'])
  })

  it('does not read a plain 400 from another endpoint as a dead cursor', async () => {
    const h = harness({ server: { files: TREE, pageSize: 50 } })
    const view = await connect(h)
    // The same `reason: invalid`, on a call that carried no cursor at all.
    h.google.queue(400, JSON.stringify({ error: { errors: [{ reason: 'invalid' }], code: 400 } }))

    await expect(h.drives.listItems(view.id)).rejects.toMatchObject({ code: 'DRIVE_PROVIDER_ERROR' })
  })
})
