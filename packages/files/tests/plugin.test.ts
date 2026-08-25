import { describe, expect, it } from 'vitest'
import { Container, HookBus, runWithContext } from '@basaltkit/core'
import { Disk, STORAGE, type StorageDriver } from '@basaltkit/storage'
import { FILES, Files, MemoryFileStore, fileRoutes, filesPlugin, type FileRecord } from '../src/index.js'
import type { HttpReply } from '@basaltkit/fastify'

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

const png = Buffer.from('fake-png-bytes')

/** Runs a plugin's `register` phase against a fresh container and returns the FILES instance. */
function build(options: Parameters<typeof filesPlugin>[0], storageDisk?: Disk) {
  const container = new Container()
  const hooks = new HookBus()
  if (storageDisk) {
    // Only string-named disks resolve through STORAGE; register a stub facade.
    container.singleton(STORAGE, () => ({ disk: () => storageDisk }) as never)
  }
  const plugin = filesPlugin(options)
  plugin.register?.({ container, hooks, config: undefined })
  return { container, hooks, files: container.get(FILES) }
}

describe('filesPlugin — construction branches', () => {
  it('builds Files from a Disk instance with every optional option set', async () => {
    const disk = new Disk('uploads', new FakeDriver())
    const store = new MemoryFileStore()
    let quotaChecked = ''
    const { files } = build({
      disk,
      store,
      validate: { maxSize: 1_000, allowedTypes: ['image/*'] },
      maxTotalBytes: 10_000,
      checkQuota: (tenantId) => {
        quotaChecked = tenantId
      },
    })
    expect(files).toBeInstanceOf(Files)
    // Prove the injected store + checkQuota are wired through the factory.
    const rec = await files.upload(png, { name: 'a.png', contentType: 'image/png', tenantId: 'acme' })
    expect(await store.find('acme', rec.id)).not.toBeNull()
    expect(quotaChecked).toBe('acme')
  })

  it('resolves a string disk name through STORAGE with no optional options', () => {
    const disk = new Disk('uploads', new FakeDriver())
    const { files } = build({ disk: 'uploads' }, disk)
    expect(files).toBeInstanceOf(Files)
  })

  it('memoises the Files singleton', () => {
    const disk = new Disk('uploads', new FakeDriver())
    const { container } = build({ disk })
    expect(container.get(FILES)).toBe(container.get(FILES))
  })
})

/** Minimal HttpReply double capturing the last status + payload. */
function fakeReply() {
  const state: { status?: number; payload?: unknown; sent: boolean } = { sent: false }
  const reply = {
    code(status: number) {
      state.status = status
      return reply
    },
    send(payload?: unknown) {
      state.payload = payload
      state.sent = true
      return reply
    },
    header() {
      return reply
    },
    get statusCode() {
      return state.status ?? 200
    },
    get sent() {
      return state.sent
    },
    raw: {},
  }
  return { reply: reply as unknown as HttpReply, state }
}

function fakeFilesService(overrides: Partial<Record<string, (...a: never[]) => unknown>> = {}) {
  const calls: Record<string, unknown[]> = {}
  const record = (k: string, ...args: unknown[]) => {
    ;(calls[k] ??= []).push(args)
  }
  const svc = {
    async list() {
      record('list')
      return [{ id: 'f1' }] as FileRecord[]
    },
    async get(id: string) {
      record('get', id)
      return null as FileRecord | null
    },
    async temporaryUrl(id: string, expiresIn: string) {
      record('temporaryUrl', id, expiresIn)
      return `https://signed/${id}?e=${expiresIn}`
    },
    async delete(id: string) {
      record('delete', id)
    },
    ...overrides,
  }
  return { svc: svc as unknown as Files, calls }
}

function withFiles<T>(svc: Files, fn: () => Promise<T>): Promise<T> {
  const container = new Container()
  container.singleton(FILES, () => svc)
  return runWithContext({ container } as never, fn)
}

const routeFor = (method: string, url: string) => {
  const r = fileRoutes().find((x) => x.method === method && x.url === url)
  if (!r) throw new Error(`route ${method} ${url} not found`)
  return r
}

describe('fileRoutes — handler branches', () => {
  it('GET /files lists the tenant files', async () => {
    const { svc, calls } = fakeFilesService()
    const out = await withFiles(svc, () => Promise.resolve(routeFor('GET', '/files').handler({} as never)))
    expect(await out).toEqual([{ id: 'f1' }])
    expect(calls.list).toHaveLength(1)
  })

  it('GET /files/:id returns the record when found', async () => {
    const found: FileRecord = { id: 'f9' } as FileRecord
    const { svc } = fakeFilesService({ get: async () => found })
    const { reply } = fakeReply()
    const out = await withFiles(svc, () => routeFor('GET', '/files/:id').handler({ params: { id: 'f9' }, reply } as never) as Promise<unknown>)
    expect(out).toBe(found)
  })

  it('GET /files/:id sends a 404 when the record is missing', async () => {
    const { svc } = fakeFilesService({ get: async () => null })
    const { reply, state } = fakeReply()
    await withFiles(svc, () => routeFor('GET', '/files/:id').handler({ params: { id: 'nope' }, reply } as never) as Promise<unknown>)
    expect(state.status).toBe(404)
    expect(state.payload).toEqual({ error: { code: 'FILE_NOT_FOUND', message: 'File not found.' } })
  })

  it('POST /files/:id/url uses the requested expiry', async () => {
    const { svc, calls } = fakeFilesService()
    const out = (await withFiles(svc, () =>
      routeFor('POST', '/files/:id/url').handler({ params: { id: 'f1' }, body: { expiresIn: '1h' } } as never) as Promise<unknown>,
    )) as { url: string }
    expect(out.url).toBe('https://signed/f1?e=1h')
    expect(calls.temporaryUrl).toEqual([['f1', '1h']])
  })

  it('POST /files/:id/url defaults the expiry to 15m when body/expiresIn is omitted', async () => {
    const { svc, calls } = fakeFilesService()
    await withFiles(svc, () => routeFor('POST', '/files/:id/url').handler({ params: { id: 'f1' } } as never) as Promise<unknown>)
    await withFiles(svc, () => routeFor('POST', '/files/:id/url').handler({ params: { id: 'f1' }, body: {} } as never) as Promise<unknown>)
    expect(calls.temporaryUrl).toEqual([
      ['f1', '15m'],
      ['f1', '15m'],
    ])
  })

  it('DELETE /files/:id deletes and replies 204', async () => {
    const { svc, calls } = fakeFilesService()
    const { reply, state } = fakeReply()
    await withFiles(svc, () => routeFor('DELETE', '/files/:id').handler({ params: { id: 'f1' }, reply } as never) as Promise<unknown>)
    expect(calls.delete).toEqual([['f1']])
    expect(state.status).toBe(204)
    expect(state.sent).toBe(true)
  })
})
