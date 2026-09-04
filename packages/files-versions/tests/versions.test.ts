import { beforeEach, describe, expect, it } from 'vitest'
import { Disk, type StorageDriver } from '@basaltkit/storage'
import { Files } from '@basaltkit/files'
import { FileVersionNotFoundError, FileVersions, MemoryFileVersionStore } from '../src/index.js'

/** The same in-memory driver the files package tests with. */
class FakeDriver implements StorageDriver {
  readonly name = 'fake'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string): Promise<void> {
    this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
  }
  async get(path: string): Promise<Buffer> {
    const buffer = this.files.get(path)
    if (!buffer) throw new Error('not found')
    return buffer
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix))
  }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> {
    return `https://fake/${path}?e=${expiresInMs}`
  }
  async disconnect(): Promise<void> {}
}

const disk = (): Disk => new Disk('uploads', new FakeDriver())

/**
 * A1 · documents have revisions; files do not.
 *
 * `Files.upload` mints a new uuid and a new path on every call, so two uploads
 * of the same contract were two unrelated records with nothing linking them.
 * Every application that needed "which draft am I reading?" wrote the same
 * group/version bookkeeping by hand.
 */

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('F-28 · FileVersions', () => {
  let versions: FileVersions
  let store: MemoryFileVersionStore

  beforeEach(() => {
    store = new MemoryFileVersionStore()
    versions = new FileVersions({ files: new Files({ disk: disk() }), store })
  })

  const upload = (groupId: string, text: string, extra: Record<string, unknown> = {}) =>
    versions.addVersion(groupId, buf(text), {
      name: 'contract.pdf',
      contentType: 'application/pdf',
      ...extra,
    })

  it('numbers revisions from one, and the store assigns the number', async () => {
    const { groupId, version } = await versions.create(buf('draft 1'), {
      name: 'contract.pdf',
      contentType: 'application/pdf',
    })
    expect(version.version).toBe(1)

    expect((await upload(groupId, 'draft 2')).version.version).toBe(2)
    expect((await upload(groupId, 'draft 3')).version.version).toBe(3)
  })

  it('keeps every earlier revision readable, with its own bytes', async () => {
    // The reason this package exists. Uploading a new draft must not touch the
    // one a client was sent last month.
    const { groupId } = await versions.create(buf('draft de Janeiro'), {
      name: 'contract.pdf',
      contentType: 'application/pdf',
    })
    await upload(groupId, 'draft de Março')

    const first = await versions.download(groupId, 1)
    const current = await versions.download(groupId)

    expect(first.content.toString()).toBe('draft de Janeiro')
    expect(current.content.toString()).toBe('draft de Março')
    // Different files, not one file rewritten.
    expect(first.record.id).not.toBe(current.record.id)
    expect(first.record.path).not.toBe(current.record.path)
  })

  it('records the note and the author of each revision', async () => {
    const { groupId } = await versions.create(buf('v1'), {
      name: 'c.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'ana',
      note: 'first draft',
    })
    await upload(groupId, 'v2', { uploadedBy: 'rui', note: 'após reunião com o client' })

    const history = await versions.history(groupId)
    // Newest first: a history is read from the top.
    expect(history.map((v) => v.version)).toEqual([2, 1])
    expect(history[0]?.note).toBe('após reunião com o client')
    expect(history[0]?.by).toBe('rui')
    expect(history[1]?.by).toBe('ana')
  })

  it('reports nothing for a document that does not exist', async () => {
    expect(await versions.latest('missing')).toBeNull()
    await expect(versions.download('missing')).rejects.toThrow(FileVersionNotFoundError)
  })

  it('refuses a revision whose file is gone rather than handing back a dangling row', async () => {
    const { groupId } = await versions.create(buf('v1'), {
      name: 'c.pdf',
      contentType: 'application/pdf',
    })

    // The same history read against a Files that has never heard of that file —
    // which is what a file deleted straight through `Files`, behind this
    // service's back, leaves behind. Returning the version as if it were
    // readable would push the failure to whoever tried to download it.
    const orphaned = new FileVersions({ files: new Files({ disk: disk() }), store })
    await expect(orphaned.latest(groupId)).rejects.toThrow(FileVersionNotFoundError)
  })
})

describe('F-28 · a history belongs to one tenant', () => {
  it('never shows one tenant another tenant history', async () => {
    // The audit sketched `history(groupId)` with no tenant. A group id is
    // exactly the kind of value that ends up in a URL, and that signature reads
    // one firm's document history from another firm's session.
    const store = new MemoryFileVersionStore()

    await store.append('acme', 'g1', 'f1', { note: 'da acme' })
    await store.append('globex', 'g1', 'f2', { note: 'da globex' })

    expect((await store.history('acme', 'g1')).map((v) => v.note)).toEqual(['da acme'])
    expect((await store.history('globex', 'g1')).map((v) => v.note)).toEqual(['da globex'])

    // And the numbering is per tenant too — both are version 1 of their own
    // document, not versions 1 and 2 of a shared one.
    expect((await store.latest('acme', 'g1'))?.version).toBe(1)
    expect((await store.latest('globex', 'g1'))?.version).toBe(1)
  })
})

describe('F-28 · with tenancy active', () => {
  it('scopes the history and the bytes to the calling tenant', async () => {
    // `tenancyActive` true is what `filesPlugin` passes when @basaltkit/tenancy
    // is registered: the disk then prefixes every path with the tenant, and an
    // unresolvable tenant is an error rather than a silent unscoped read.
    const store = new MemoryFileVersionStore()
    const files = new Files({ disk: disk() }, () => true)
    const versions = new FileVersions({ files, store })

    const acme = await versions.create(buf('draft da acme'), {
      name: 'c.pdf',
      contentType: 'application/pdf',
      tenantId: 'acme',
    })
    await versions.addVersion(acme.groupId, buf('draft da globex'), {
      name: 'c.pdf',
      contentType: 'application/pdf',
      tenantId: 'globex',
    })

    // Same group id, two tenants: each sees one revision, numbered 1, and reads
    // back its own bytes. If the scope key and the tenant id were confused,
    // this is where it would show.
    expect((await versions.history(acme.groupId, 'acme')).map((v) => v.version)).toEqual([1])
    expect((await versions.history(acme.groupId, 'globex')).map((v) => v.version)).toEqual([1])
    expect((await versions.download(acme.groupId, undefined, 'acme')).content.toString()).toBe(
      'draft da acme',
    )
    expect((await versions.download(acme.groupId, undefined, 'globex')).content.toString()).toBe(
      'draft da globex',
    )
  })
})

describe('F-28 · the ambient tenant, with nothing passed explicitly', () => {
  it('reads back what it wrote', async () => {
    // `Files.upload` resolves the tenant from `ctx()`, so the version row is
    // written under `acme`. If this service does not resolve it the same way,
    // the read looks somewhere else and answers "no such document" about a
    // document that exists — a silent wrong answer, which is the one failure
    // mode this package set out to prevent.
    const { runWithContext } = await import('@basaltkit/core')
    const store = new MemoryFileVersionStore()
    const files = new Files({ disk: disk() }, () => true)
    const versions = new FileVersions({ files, store })

    const { groupId } = await runWithContext({ tenant: { id: 'acme' } }, () =>
      versions.create(buf('v1'), { name: 'c.pdf', contentType: 'application/pdf' }),
    )

    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      expect(await versions.history(groupId)).toHaveLength(1)
      expect((await versions.latest(groupId))?.version.version).toBe(1)
      expect((await versions.download(groupId)).content.toString()).toBe('v1')
    })
  })

  it('does not let one tenant read another by omitting the argument', async () => {
    const { runWithContext } = await import('@basaltkit/core')
    const store = new MemoryFileVersionStore()
    const files = new Files({ disk: disk() }, () => true)
    const versions = new FileVersions({ files, store })

    const { groupId } = await runWithContext({ tenant: { id: 'acme' } }, () =>
      versions.create(buf('v1'), { name: 'c.pdf', contentType: 'application/pdf' }),
    )

    await runWithContext({ tenant: { id: 'globex' } }, async () => {
      expect(await versions.history(groupId)).toEqual([])
      expect(await versions.latest(groupId)).toBeNull()
    })
  })
})
