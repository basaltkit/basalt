import { describe, expect, it, vi } from 'vitest'
import { importItem } from '../src/import.js'
import { dueConnections, syncConnection, type DriveImportTask } from '../src/sync.js'
import { connect, harness, recordingSink } from './helpers.js'

/** Collects what the sync would have queued. */
function collector() {
  const tasks: DriveImportTask[] = []
  return { tasks, enqueue: async (task: DriveImportTask) => void tasks.push(task) }
}

const FILES = [
  { externalId: 'f1', name: 'a.txt' },
  { externalId: 'f2', name: 'b.txt' },
  { externalId: 'f3', name: 'c.txt' },
]

describe('syncConnection — delta mode', () => {
  it('uses the change feed when the adapter offers one', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const { tasks, enqueue } = collector()

    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })

    expect(result.mode).toBe('delta')
    expect(result.enqueued).toBe(3)
    expect(tasks.map((t) => t.item.externalId).sort()).toEqual(['f1', 'f2', 'f3'])
  })

  it('does NOT download anything — that is the queue’s job', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const { enqueue } = collector()

    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })

    // The whole point: a connect-and-sync request finishes in the time it
    // takes to read metadata, whatever the size of the drive behind it.
    expect(h.fake.calls['download']).toBeUndefined()
  })

  it('persists the cursor so the next run is incremental', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const { enqueue } = collector()

    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })
    const afterFirst = await h.store.find('acme', view.id)
    expect(afterFirst?.cursor).toBeDefined()
    expect(afterFirst?.lastSyncedAt).toBeDefined()

    const second = collector()
    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: second.enqueue })
    // Nothing changed at the provider, so an incremental run sees nothing.
    expect(result.enqueued).toBe(0)
  })

  it('picks up only what changed since the last run', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: collector().enqueue })

    h.fake.edit('f2', 'changed')
    h.fake.put({ externalId: 'f4', name: 'd.txt' })
    const second = collector()
    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: second.enqueue })

    expect(result.enqueued).toBe(2)
    expect(second.tasks.map((t) => t.item.externalId).sort()).toEqual(['f2', 'f4'])
  })

  it('reports removals instead of deleting anything itself', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    const { sink } = recordingSink()
    const first = collector()
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: first.enqueue })
    for (const task of first.tasks) await importItem(h.drives, view.id, task.item, sink, { tenantId: 'acme' })

    h.fake.remove('f1')
    const removals: unknown[] = []
    const result = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: collector().enqueue,
      onRemoved: (removal) => void removals.push(removal),
    })

    expect(result.removed).toBe(1)
    // Retention is a legal question, not a framework one: it reports, the app
    // decides. And it hands over what the ledger knew, so the app can act.
    expect(removals[0]).toMatchObject({ externalId: 'f1', targetId: 'target-1' })
  })

  it('pages through a large change feed', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ externalId: `f${i}`, name: `${i}.txt` }))
    const h = harness({ provider: { files: many, pageSize: 10 } })
    const view = await connect(h, { tenantId: 'acme' })
    const { tasks, enqueue } = collector()

    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })
    expect(result.enqueued).toBe(25)
    expect(tasks).toHaveLength(25)
  })
})

describe('syncConnection — bounds', () => {
  it('stops at maxItems and reports the run as truncated', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ externalId: `f${i}`, name: `${i}.txt` }))
    const h = harness({ provider: { files: many, pageSize: 5 } })
    const view = await connect(h, { tenantId: 'acme' })
    const { enqueue } = collector()

    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue, maxItems: 10 })

    expect(result.truncated).toBe(true)
    // A hard ceiling, not a hint: one tenant's first sync must not become an
    // outage. The cursor carries the rest to the next run.
    expect(result.enqueued).toBeLessThanOrEqual(15)
  })

  it('resumes from the persisted cursor after a truncated run', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ externalId: `f${i}`, name: `${i}.txt` }))
    const h = harness({ provider: { files: many, pageSize: 5 } })
    const view = await connect(h, { tenantId: 'acme' })

    const first = collector()
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: first.enqueue, maxItems: 5 })
    const second = collector()
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: second.enqueue, maxItems: 5 })

    const firstIds = new Set(first.tasks.map((t) => t.item.externalId))
    const secondIds = second.tasks.map((t) => t.item.externalId)
    // No overlap: the cursor advanced rather than restarting.
    expect(secondIds.some((id) => firstIds.has(id))).toBe(false)
  })

  it('caps the number of pages in one run', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ externalId: `f${i}`, name: `${i}.txt` }))
    const h = harness({ provider: { files: many, pageSize: 2 } })
    const view = await connect(h, { tenantId: 'acme' })
    const { enqueue } = collector()

    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue, maxPages: 3, maxItems: 10_000 })
    expect(result.truncated).toBe(true)
    expect(h.fake.calls['delta']).toBeLessThanOrEqual(3)
  })

  it('stops when the caller aborts', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ externalId: `f${i}`, name: `${i}.txt` }))
    const h = harness({ provider: { files: many, pageSize: 5 } })
    const view = await connect(h, { tenantId: 'acme' })
    const controller = new AbortController()
    const tasks: DriveImportTask[] = []

    const result = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      signal: controller.signal,
      enqueue: async (task) => {
        tasks.push(task)
        if (tasks.length >= 5) controller.abort()
      },
    })
    expect(result.enqueued).toBeLessThan(50)
  })
})

describe('syncConnection — listing fallback', () => {
  it('falls back to a full listing when the adapter has no change feed', async () => {
    const h = harness({ provider: { files: FILES, supportsDelta: false } })
    const view = await connect(h, { tenantId: 'acme' })
    const { tasks, enqueue } = collector()

    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })

    expect(result.mode).toBe('listing')
    expect(tasks.map((t) => t.item.externalId).sort()).toEqual(['f1', 'f2', 'f3'])
  })

  it('still dedups through the ledger on the fallback path', async () => {
    const h = harness({ provider: { files: FILES, supportsDelta: false } })
    const view = await connect(h, { tenantId: 'acme' })
    const { sink, seen } = recordingSink()

    for (let run = 0; run < 2; run++) {
      const { tasks, enqueue } = collector()
      await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue })
      for (const task of tasks) await importItem(h.drives, view.id, task.item, sink, { tenantId: 'acme' })
    }
    // A full listing re-reports everything; the ledger is what stops the second
    // run from re-downloading it.
    expect(seen).toHaveLength(3)
  })
})

describe('syncConnection — isolation and hooks', () => {
  it('cannot sync another tenant’s connection', async () => {
    const h = harness({ provider: { files: FILES } })
    const acme = await connect(h, { tenantId: 'acme' })
    await expect(
      syncConnection(h.drives, acme.id, { tenantId: 'globex', enqueue: collector().enqueue }),
    ).rejects.toMatchObject({ code: 'DRIVE_CONNECTION_NOT_FOUND' })
  })

  it('emits sync hooks with no credentials', async () => {
    const emitted: { hook: string; payload: unknown }[] = []
    const hooks = { emit: vi.fn(async (hook: string, payload: unknown) => void emitted.push({ hook, payload })) }
    const h = harness({ provider: { files: FILES }, drives: { hooks: hooks as never } })
    const view = await connect(h, { tenantId: 'acme' })

    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: collector().enqueue })

    expect(emitted.map((e) => e.hook)).toEqual(
      expect.arrayContaining(['drive:sync_started', 'drive:sync_completed']),
    )
    expect(JSON.stringify(emitted)).not.toContain('access-')
  })

  it('emits drive:sync_failed with a message, never the error object', async () => {
    const emitted: { hook: string; payload: Record<string, unknown> }[] = []
    const hooks = { emit: vi.fn(async (hook: string, payload: unknown) => void emitted.push({ hook, payload: payload as Record<string, unknown> })) }
    const h = harness({ provider: { files: FILES }, drives: { hooks: hooks as never } })
    const view = await connect(h, { tenantId: 'acme' })
    h.fake.authorization.refresh = async () => {
      throw new Error('boom https://api.provider.test/download?token=SECRET')
    }
    h.advance(61 * 60_000)

    await expect(syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: collector().enqueue })).rejects.toThrow()
    const failure = emitted.find((e) => e.hook === 'drive:sync_failed')
    expect(failure).toBeDefined()
    expect(typeof failure?.payload['reason']).toBe('string')
  })
})

describe('dueConnections', () => {
  it('returns connections that have never synced', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme', label: 'Never synced' })
    expect((await dueConnections(h.drives, { tenantId: 'acme' })).map((c) => c.label)).toEqual(['Never synced'])
  })

  it('excludes a connection synced recently and includes a stale one', async () => {
    const h = harness({ provider: { files: FILES } })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: collector().enqueue })

    expect(await dueConnections(h.drives, { tenantId: 'acme', staleForMs: 60_000 })).toHaveLength(0)
    h.advance(120_000)
    expect(await dueConnections(h.drives, { tenantId: 'acme', staleForMs: 60_000 })).toHaveLength(1)
  })

  it('never returns an invalid connection', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    await h.store.update('acme', view.id, { status: 'invalid' })
    expect(await dueConnections(h.drives, { tenantId: 'acme' })).toHaveLength(0)
  })

  it('is scoped to one tenant', async () => {
    const h = harness()
    await connect(h, { tenantId: 'acme', label: 'Acme' })
    await connect(h, { tenantId: 'globex', label: 'Globex' })
    expect((await dueConnections(h.drives, { tenantId: 'acme' })).map((c) => c.label)).toEqual(['Acme'])
  })
})
