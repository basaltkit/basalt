import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createDriveFetch, RATE_LIMIT_BODY_BYTES, type Transport } from '../src/fetch.js'
import { DriveProviderError } from '../src/errors.js'
import { isRetryable } from '../src/retry.js'
import { syncConnection, type DriveImportTask, type DriveRemoval } from '../src/sync.js'
import { connect, harness } from './helpers.js'

/**
 * The contract changes phase 2a made, each with the Dropbox behaviour that
 * forced it. Every one of these fails on the phase-1 contract.
 */

const ok = (body: string, status = 200, headers: Record<string, string> = {}): ReturnType<Transport> =>
  Promise.resolve({ status, headers, body: Readable.from([Buffer.from(body)]) })

describe('the guarded fetch can stream a request body', () => {
  it('pipes a Readable instead of buffering it', async () => {
    let seen = ''
    const transport: Transport = async (_url, init) => {
      const chunks: Buffer[] = []
      for await (const chunk of init.body as Readable) chunks.push(Buffer.from(chunk as Buffer))
      seen = Buffer.concat(chunks).toString('utf8')
      return ok('{}')
    }
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await fetch('https://api.provider.test/upload', {
      method: 'POST',
      body: Readable.from([Buffer.from('part1'), Buffer.from('part2')]),
    })
    // Phase 1 typed the body as `string | Buffer`, which made an upload of any
    // size a full in-memory copy — 150 MB per concurrent job for Dropbox.
    expect(seen).toBe('part1part2')
  })

  it('destroys a streamed body on a redirect instead of leaving it dangling', async () => {
    const source = Readable.from([Buffer.from('payload')])
    const transport: Transport = async (url) =>
      url.pathname === '/start'
        ? ok('', 303, { location: 'https://api.provider.test/done' })
        : ok('{}')
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })

    await fetch('https://api.provider.test/start', { method: 'POST', body: source })
    // A streamed body cannot be replayed, so it is not silently re-sent as
    // nothing; the socket is released.
    expect(source.destroyed).toBe(true)
  })
})

describe('a vendor rate-limit hint that is not in Retry-After', () => {
  const rateLimited = (body: string, headers: Record<string, string> = {}): Transport => async () =>
    ok(body, 429, headers)

  it('reads the hint out of the body when the provider declares a parser', async () => {
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport: rateLimited(JSON.stringify({ error: { retry_after: 5 } })),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      retryAfterFromBody: (body) => {
        const parsed = JSON.parse(body) as { error?: { retry_after?: number } }
        return parsed.error?.retry_after !== undefined ? parsed.error.retry_after * 1000 : undefined
      },
    })
    await expect(fetch('https://api.provider.test/x')).rejects.toMatchObject({
      code: 'DRIVE_RATE_LIMITED',
      retryAfterMs: 5000,
    })
  })

  it('lets the Retry-After header win, and never reads the body for it', async () => {
    let read = false
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport: rateLimited(JSON.stringify({ error: { retry_after: 5 } }), { 'retry-after': '2' }),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      retryAfterFromBody: () => {
        read = true
        return 5000
      },
    })
    await expect(fetch('https://api.provider.test/x')).rejects.toMatchObject({ retryAfterMs: 2000 })
    expect(read).toBe(false)
  })

  it('bounds how much of a rate-limited body it will read', async () => {
    let sawBytes = 0
    const huge = 'x'.repeat(RATE_LIMIT_BODY_BYTES * 4)
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport: async () => ok(huge, 429),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      retryAfterFromBody: (body) => {
        sawBytes = body.length
        return undefined
      },
    })
    await expect(fetch('https://api.provider.test/x')).rejects.toMatchObject({ code: 'DRIVE_RATE_LIMITED' })
    // A throttled provider must not be able to make us read more.
    expect(sawBytes).toBeLessThanOrEqual(RATE_LIMIT_BODY_BYTES)
  })

  it('still rate-limits when the parser throws', async () => {
    const fetch = createDriveFetch({
      allowedHosts: ['api.provider.test'],
      provider: 'p',
      transport: rateLimited('not json'),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      retryAfterFromBody: () => {
        throw new Error('bad parser')
      },
    })
    // An error path must not be able to raise a second, different error.
    await expect(fetch('https://api.provider.test/x')).rejects.toMatchObject({
      code: 'DRIVE_RATE_LIMITED',
      retryAfterMs: undefined,
    })
  })
})

describe('DriveProviderError', () => {
  it('is the one DRIVE_ code whose retryability the adapter decides', () => {
    expect(isRetryable(new DriveProviderError('p', 'internal_error/', 500, true))).toBe(true)
    expect(isRetryable(new DriveProviderError('p', 'path/conflict/', 409, false))).toBe(false)
  })
})

describe('a change feed that starts at "now"', () => {
  it('runs a listing pass first, so the existing corpus is not silently skipped', async () => {
    // Google Drive's `changes.getStartPageToken` is exactly this shape. Phase 1
    // took the cursor and went straight to the change feed, which returns
    // nothing — a first sync that imports none of the tenant's files.
    const h = harness({
      provider: {
        deltaIncludesExisting: false,
        files: [
          { externalId: 'f1', name: 'a.txt' },
          { externalId: 'f2', name: 'b.txt' },
        ],
      },
    })
    const view = await connect(h, { tenantId: 'acme' })
    const tasks: DriveImportTask[] = []

    const first = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => void tasks.push(task),
    })

    expect(first.mode).toBe('listing')
    expect(tasks.map((t) => t.item.externalId).sort()).toEqual(['f1', 'f2'])
    // The cursor was taken BEFORE the listing, so a change during it is
    // re-delivered rather than lost — and it is only persisted now that the
    // listing finished.
    expect((await h.store.find('acme', view.id))!.cursor).toBeTruthy()

    h.fake.put({ externalId: 'f3', name: 'c.txt' })
    const second = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => void tasks.push(task),
    })
    expect(second.mode).toBe('delta')
    expect(tasks.at(-1)!.item.externalId).toBe('f3')
  })

  it('does not switch to the change feed after a truncated backfill', async () => {
    const h = harness({
      provider: {
        deltaIncludesExisting: false,
        pageSize: 1,
        files: [
          { externalId: 'f1', name: 'a.txt' },
          { externalId: 'f2', name: 'b.txt' },
          { externalId: 'f3', name: 'c.txt' },
        ],
      },
    })
    const view = await connect(h, { tenantId: 'acme' })

    const run = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      maxPages: 1,
      enqueue: async () => {},
    })

    expect(run.truncated).toBe(true)
    // Persisting the DELTA cursor here would skip everything the ceiling cut
    // off, and no later run would ever go back for it — that is still true and
    // is what this test protects. What replaced it is the engine's own resume
    // point, so the next run *continues* the enumeration: clearing the cursor
    // outright (which this used to assert) restarts the walk from the top on
    // every run and never gets past the ceiling at all. See the
    // backfill-resumption suite in `audit-phase2.test.ts`.
    const stored = (await h.store.find('acme', view.id))!.cursor
    expect(stored).toContain('backfill')

    const next = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      maxPages: 1,
      enqueue: async () => {},
    })
    // Still enumerating — the parked state is never handed to `provider.delta`.
    expect(next.mode).toBe('listing')
  })

  it('goes straight to the change feed for an adapter that backfills itself', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    // The fake's cursor '0' really is the head of the log, and it says so.
    expect(h.fake.deltaIncludesExisting).toBe(true)
    expect(result.mode).toBe('delta')
    expect(h.fake.calls['list']).toBeUndefined()
  })
})

describe('a removal the provider reports by path', () => {
  it('reaches onRemoved with the path and no invented id', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const removals: DriveRemoval[] = []
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })

    // The Dropbox shape: `{".tag":"deleted", path_display}` and nothing else.
    const fake = h.fake as unknown as { state?: unknown }
    void fake
    ;(h.fake as unknown as { delta: unknown }).delta = async () => ({
      changes: [{ type: 'removed', path: '/Finance/a.txt' }],
      cursor: '99',
      hasMore: false,
    })

    const result = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async () => {},
      onRemoved: (removal) => void removals.push(removal),
    })

    expect(result.removed).toBe(1)
    expect(removals[0]).toMatchObject({ tenantId: 'acme', connectionId: view.id, path: '/Finance/a.txt' })
    expect(removals[0]!.externalId).toBeUndefined()
    // No ledger lookup is possible, so no `targetId` is invented.
    expect(removals[0]!.targetId).toBeUndefined()
  })

  it('still resolves the ledger entry for an id-based removal', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    await h.ledger.record({
      tenantId: 'acme',
      connectionId: view.id,
      externalId: 'f1',
      version: 'v:r1',
      targetId: 'file-1',
      strategy: 'copy',
      importedAt: h.now(),
    })
    h.fake.remove('f1')
    const removals: DriveRemoval[] = []

    await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async () => {},
      onRemoved: (removal) => void removals.push(removal),
    })

    expect(removals.at(-1)).toMatchObject({ externalId: 'f1', targetId: 'file-1' })
  })
})

describe('a cursor the provider invalidated', () => {
  it('is dropped, so the next run re-primes instead of failing for ever', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })
    expect((await h.store.find('acme', view.id))!.cursor).toBeTruthy()

    // Dropbox's `reset/`, Graph's `resyncRequired`, an aged-out Google
    // pageToken. The cursor is persisted, so anything other than dropping it
    // fails identically on every future run — no retry policy can help.
    h.fake.resetNextDelta = true
    const result = await syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} })

    expect(result.reset).toBe(true)
    expect(result.truncated).toBe(true)
    expect((await h.store.find('acme', view.id))!.cursor).toBeUndefined()

    // And the next run genuinely starts again rather than stalling.
    const tasks: DriveImportTask[] = []
    const recovered = await syncConnection(h.drives, view.id, {
      tenantId: 'acme',
      enqueue: async (task) => void tasks.push(task),
    })
    expect(recovered.reset).toBeUndefined()
    expect(tasks.map((t) => t.item.externalId)).toEqual(['f1'])
  })

  it('does not swallow any other provider failure', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    ;(h.fake as unknown as { delta: unknown }).delta = async () => {
      throw new DriveProviderError('fake', 'internal_error/', 500, false)
    }
    await expect(
      syncConnection(h.drives, view.id, { tenantId: 'acme', enqueue: async () => {} }),
    ).rejects.toMatchObject({ code: 'DRIVE_PROVIDER_ERROR' })
  })
})
