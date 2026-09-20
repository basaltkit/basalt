import { describe, expect, it, vi } from 'vitest'
import { contentVersion, filesSink, importItem } from '../src/import.js'
import type { DriveItem } from '../src/provider.js'
import { connect, harness, readAll, recordingSink } from './helpers.js'

/** Lets a test set a field back to `undefined` under exactOptionalPropertyTypes. */
type ItemOverrides = { [K in keyof DriveItem]?: DriveItem[K] | undefined }

const ITEM = (overrides: ItemOverrides = {}): DriveItem =>
  ({
    externalId: 'f1',
    name: 'invoice.pdf',
    kind: 'file',
    contentType: 'application/pdf',
    version: 'r1',
    ...overrides,
  }) as DriveItem

describe('contentVersion', () => {
  it('prefers the provider revision', () => {
    expect(contentVersion(ITEM({ version: 'r7', checksum: { algorithm: 'md5', value: 'abc' } }))).toBe('v:r7')
  })

  it('falls back to a checksum', () => {
    expect(contentVersion(ITEM({ version: undefined, checksum: { algorithm: 'sha256', value: 'ab' } }))).toBe('sha256:ab')
  })

  it('falls back to updatedAt + size, not updatedAt alone', () => {
    expect(contentVersion(ITEM({ version: undefined, updatedAt: 1000, size: 42 }))).toBe('t:1000:42')
  })

  it('treats an item with no version signal at all as always-changed', () => {
    const bare = ITEM({ version: undefined, updatedAt: undefined, size: undefined })
    // Two reads must differ, so the safe direction is a redundant import
    // rather than a silently missed update.
    expect(contentVersion(bare)).not.toBe(contentVersion(bare))
  })
})

describe('importItem', () => {
  it('streams the bytes through the sink and records the import', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'invoice.pdf', content: 'INVOICE BODY' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const { sink, seen } = recordingSink()
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

    const outcome = await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })

    expect(outcome).toMatchObject({ status: 'imported' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toBe('INVOICE BODY')
    const ledgered = await h.ledger.find('acme', view.id, 'f1')
    expect(ledgered).toMatchObject({ externalId: 'f1', strategy: 'copy', targetId: 'target-1' })
  })

  describe('dedup', () => {
    it('skips an item already imported at the same version — without downloading it', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })
      const downloadsAfterFirst = h.fake.calls['download']
      const second = await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })

      expect(second).toEqual({ status: 'skipped', reason: 'unchanged' })
      // The ledger is consulted BEFORE the download: an unchanged file must
      // cost a local read, not its own size in egress.
      expect(h.fake.calls['download']).toBe(downloadsAfterFirst)
    })

    it('re-imports when the content version changed', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt', content: 'v1' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink, seen } = recordingSink()
      const first = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
      await importItem(h.drives, view.id, first, sink, { tenantId: 'acme' })

      h.fake.edit('f1', 'v2 content')
      const updated = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
      const outcome = await importItem(h.drives, view.id, updated, sink, { tenantId: 'acme' })

      expect(outcome.status).toBe('imported')
      expect(seen.map((s) => s.body)).toEqual(['v1', 'v2 content'])
    })

    it('re-imports on demand with force', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })

      const forced = await importItem(h.drives, view.id, item, sink, { tenantId: 'acme', force: true })
      expect(forced.status).toBe('imported')
    })

    it('keys the ledger per connection, so two connections import independently', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const finance = await connect(h, { tenantId: 'acme', label: 'Finance' })
      const hr = await connect(h, { tenantId: 'acme', label: 'HR' })
      const { sink, seen } = recordingSink()
      const item = (await h.drives.listItems(finance.id, { tenantId: 'acme' })).items[0]!

      await importItem(h.drives, finance.id, item, sink, { tenantId: 'acme' })
      const viaHr = await importItem(h.drives, hr.id, item, sink, { tenantId: 'acme' })

      // Same external id, different connection: a legitimately separate import.
      expect(viaHr.status).toBe('imported')
      expect(seen).toHaveLength(2)
    })

    it('keys the ledger per tenant', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const acme = await connect(h, { tenantId: 'acme' })
      await connect(h, { tenantId: 'globex' })
      const { sink } = recordingSink()
      const item = (await h.drives.listItems(acme.id, { tenantId: 'acme' })).items[0]!
      await importItem(h.drives, acme.id, item, sink, { tenantId: 'acme' })

      expect(await h.ledger.find('globex', acme.id, 'f1')).toBeNull()
    })
  })

  describe('strategies', () => {
    it('copy downloads the bytes', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt', content: 'bytes' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink, seen } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme', strategy: 'copy' })
      expect(seen[0]?.body).toBe('bytes')
      expect(h.fake.calls['download']).toBe(1)
    })

    it('reference downloads NOTHING', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt', content: 'bytes' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink, seen } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme', strategy: 'reference' })

      expect(seen[0]?.body).toBeUndefined()
      // The defining property of the strategy: no egress, no copy.
      expect(h.fake.calls['download']).toBeUndefined()
      expect((await h.ledger.find('acme', view.id, 'f1'))?.strategy).toBe('reference')
    })
  })

  describe('filtering', () => {
    it('never imports a folder', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      const outcome = await importItem(h.drives, view.id, ITEM({ kind: 'folder' }), sink, { tenantId: 'acme' })
      expect(outcome).toEqual({ status: 'skipped', reason: 'filtered' })
    })

    it('honours a caller filter before downloading', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'notes.txt' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      const outcome = await importItem(h.drives, view.id, item, sink, {
        tenantId: 'acme',
        filter: (candidate) => candidate.name.endsWith('.pdf'),
      })
      expect(outcome).toEqual({ status: 'skipped', reason: 'filtered' })
      expect(h.fake.calls['download']).toBeUndefined()
    })
  })

  describe('failure handling', () => {
    it('does not record a ledger entry when the sink throws', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      await expect(
        importItem(h.drives, view.id, item, async () => {
          throw new Error('sink exploded')
        }, { tenantId: 'acme' }),
      ).rejects.toThrow('sink exploded')

      // A ledger entry here would mean the item is never retried.
      expect(await h.ledger.find('acme', view.id, 'f1')).toBeNull()
    })

    it('destroys the download stream when the sink throws', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const view = await connect(h, { tenantId: 'acme' })
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
      let captured: { destroyed: boolean } | undefined

      await expect(
        importItem(h.drives, view.id, item, async ({ content }) => {
          captured = content?.stream
          throw new Error('sink exploded')
        }, { tenantId: 'acme' }),
      ).rejects.toThrow()

      // Leaving it open holds the socket until a timeout.
      expect(captured?.destroyed).toBe(true)
    })

    it('cannot import through another tenant’s connection', async () => {
      const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
      const acme = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      await expect(
        importItem(h.drives, acme.id, ITEM(), sink, { tenantId: 'globex' }),
      ).rejects.toMatchObject({ code: 'DRIVE_CONNECTION_NOT_FOUND' })
    })
  })

  describe('hooks', () => {
    it('emits drive:item_imported and drive:item_skipped, with no credentials in the payload', async () => {
      const emitted: { hook: string; payload: unknown }[] = []
      const hooks = { emit: vi.fn(async (hook: string, payload: unknown) => void emitted.push({ hook, payload })) }
      const h = harness({
        provider: { files: [{ externalId: 'f1', name: 'a.txt' }] },
        drives: { hooks: hooks as never },
      })
      const view = await connect(h, { tenantId: 'acme' })
      const { sink } = recordingSink()
      const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })
      await importItem(h.drives, view.id, item, sink, { tenantId: 'acme' })

      expect(emitted.map((e) => e.hook)).toContain('drive:item_imported')
      expect(emitted.map((e) => e.hook)).toContain('drive:item_skipped')
      const serialised = JSON.stringify(emitted)
      expect(serialised).not.toContain('access-')
      expect(serialised).not.toContain('refresh-')
    })
  })
})

describe('filesSink', () => {
  it('streams into a Files-shaped target with drive provenance in the metadata', async () => {
    const uploads: { name: string; contentType: string; body: string; metadata: unknown; tenantId?: string }[] = []
    const files = {
      upload: async (content: AsyncIterable<Uint8Array | string>, input: Record<string, unknown>) => {
        const chunks: Buffer[] = []
        for await (const chunk of content) chunks.push(Buffer.from(chunk as Buffer))
        uploads.push({
          name: input['name'] as string,
          contentType: input['contentType'] as string,
          body: Buffer.concat(chunks).toString('utf8'),
          metadata: input['metadata'],
          tenantId: input['tenantId'] as string,
        })
        return { id: `file-${uploads.length}` }
      },
    }

    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'report.txt', content: 'REPORT' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

    const outcome = await importItem(h.drives, view.id, item, filesSink(files), { tenantId: 'acme' })

    expect(outcome).toMatchObject({ status: 'imported', targetId: 'file-1' })
    expect(uploads[0]).toMatchObject({ name: 'report.txt', body: 'REPORT', tenantId: 'acme' })
    expect(uploads[0]?.metadata).toMatchObject({
      driveProvider: 'fake',
      driveConnectionId: view.id,
      driveExternalId: 'f1',
    })
  })

  it('refuses the reference strategy, which has no bytes to store', async () => {
    const files = { upload: async () => ({ id: 'x' }) }
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

    await expect(
      importItem(h.drives, view.id, item, filesSink(files), { tenantId: 'acme', strategy: 'reference' }),
    ).rejects.toThrow(/reference/)
  })

  it('passes the declared content type through as a starting point for sniffing', async () => {
    const seen: string[] = []
    const files = {
      upload: async (content: AsyncIterable<Uint8Array | string>, input: Record<string, unknown>) => {
        for await (const _chunk of content) {
          /* drain */
        }
        seen.push(input['contentType'] as string)
        return { id: 'f' }
      },
    }
    const h = harness({
      provider: { files: [{ externalId: 'f1', name: 'a.pdf', contentType: 'application/pdf' }] },
    })
    const view = await connect(h, { tenantId: 'acme' })
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!
    await importItem(h.drives, view.id, item, filesSink(files), { tenantId: 'acme' })

    // Only a starting point: @basaltkit/files' `validate.sniff` overrides it
    // from the bytes, which is why a provider's declared type is never trusted.
    expect(seen).toEqual(['application/pdf'])
  })
})

describe('download streaming', () => {
  it('hands back a stream rather than a buffer', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt', content: 'streamed' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    const item = (await h.drives.listItems(view.id, { tenantId: 'acme' })).items[0]!

    const content = await h.drives.download(view.id, item, { tenantId: 'acme' })
    expect(typeof content.stream.pipe).toBe('function')
    expect(await readAll(content.stream)).toBe('streamed')
  })
})
