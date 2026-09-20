import { describe, expect, it } from 'vitest'
import { syncConnection, type DriveImportTask, type DriveRemoval } from '@basaltkit/drives'
import { connect, harness } from './helpers.js'

const FILES = [
  { id: 'id:a', path: '/Finance/invoice.pdf', content: 'invoice' },
  { id: 'id:b', path: '/Finance/receipt.pdf', content: 'receipt' },
  { id: 'id:c', path: '/Finance/notes.txt', content: 'notes' },
]

function collector() {
  const tasks: DriveImportTask[] = []
  const removals: DriveRemoval[] = []
  return {
    tasks,
    removals,
    enqueue: async (task: DriveImportTask) => void tasks.push(task),
    onRemoved: (removal: DriveRemoval) => void removals.push(removal),
  }
}

describe('Dropbox change feed', () => {
  it('backfills the existing corpus on the first run and then follows changes', async () => {
    // The property that makes `deltaIncludesExisting: true` honest for Dropbox:
    // `list_folder` IS the head of the feed, so the first delta run enumerates
    // rather than returning nothing. Google's getStartPageToken is the opposite
    // and the contract now distinguishes them.
    const h = harness({ server: { files: FILES, pageSize: 5 } })
    const view = await connect(h)
    const first = collector()

    const result = await syncConnection(h.drives, view.id, { enqueue: first.enqueue })
    expect(result.mode).toBe('delta')
    expect(first.tasks.map((t) => t.item.externalId).sort()).toEqual(['id:a', 'id:b', 'id:c'])
    expect(result.cursor).toBeTruthy()
    // The first call turns the synthetic start cursor into a real list_folder.
    expect(h.dropbox.requests.some((r) => r.url.endsWith('/files/list_folder'))).toBe(true)

    h.dropbox.put({ id: 'id:d', path: '/Finance/new.pdf', content: 'new' })
    const second = collector()
    await syncConnection(h.drives, view.id, { enqueue: second.enqueue })
    expect(second.tasks.map((t) => t.item.externalId)).toEqual(['id:d'])
  })

  it('persists the cursor after every page, so a truncated run resumes', async () => {
    const h = harness({ server: { files: FILES, pageSize: 1 } })
    const view = await connect(h)

    const first = collector()
    const run = await syncConnection(h.drives, view.id, { enqueue: first.enqueue, maxPages: 2 })
    expect(run.truncated).toBe(true)
    const stored = (await h.store.find('default', view.id))!
    expect(stored.cursor).toBeTruthy()

    const second = collector()
    await syncConnection(h.drives, view.id, { enqueue: second.enqueue, maxPages: 5 })
    const firstIds = new Set(first.tasks.map((t) => t.item.externalId))
    // No overlap: the cursor advanced rather than restarting from the top.
    expect(second.tasks.some((t) => firstIds.has(t.item.externalId))).toBe(false)
  })

  it('reports a deletion by PATH, because Dropbox gives no id for one', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    const first = collector()
    await syncConnection(h.drives, view.id, { enqueue: first.enqueue })

    h.dropbox.remove('id:a')
    const second = collector()
    const result = await syncConnection(h.drives, view.id, {
      enqueue: second.enqueue,
      onRemoved: second.onRemoved,
    })

    expect(result.removed).toBe(1)
    expect(second.removals).toHaveLength(1)
    // This is the contract change the first adapter forced: a Dropbox deletion
    // carries `{".tag":"deleted", path_display}` and NOTHING else. Phase 1
    // required an `externalId`, so a path would have had to be smuggled into
    // it — and every ledger lookup would have missed in silence.
    expect(second.removals[0]!.externalId).toBeUndefined()
    expect(second.removals[0]!.path).toBe('/Finance/invoice.pdf')
    expect(second.removals[0]!.targetId).toBeUndefined()
  })

  it('never downloads during a sync', async () => {
    const h = harness({ server: { files: FILES, pageSize: 10 } })
    const view = await connect(h)
    await syncConnection(h.drives, view.id, { enqueue: collector().enqueue })
    expect(h.dropbox.requests.some((r) => r.url.includes('/files/download'))).toBe(false)
  })
})
