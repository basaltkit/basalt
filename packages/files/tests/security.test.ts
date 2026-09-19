import { describe, expect, it } from 'vitest'
import { Container, runWithContext } from '@basaltkit/core'
import { Disk, type StorageDriver } from '@basaltkit/storage'
import {
  FILES,
  FileTenantMismatchError,
  Files,
  MemoryFileStore,
  StorageQuotaExceededError,
  fileRoutes,
  type FileRecord,
  type FileRoutesOptions,
} from '../src/index.js'

class FakeDriver implements StorageDriver {
  readonly name = 'fake'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string): Promise<void> {
    // Yield so concurrent uploads genuinely interleave, as a network disk would.
    await new Promise((resolve) => setTimeout(resolve, 1))
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

function fakeReply() {
  const state: { status?: number; payload?: unknown } = {}
  const reply = {
    code(status: number) {
      state.status = status
      return reply
    },
    send(payload?: unknown) {
      state.payload = payload
      return reply
    },
    header() {
      return reply
    },
  }
  return { reply, state }
}

const png = Buffer.from('fake-png-bytes')

function setup(routeOptions?: FileRoutesOptions) {
  const driver = new FakeDriver()
  const files = new Files({ disk: new Disk('uploads', driver) })
  const container = new Container()
  container.singleton(FILES, () => files)
  const routes = fileRoutes(routeOptions)
  const find = (method: string, url: string) => routes.find((r) => r.method === method && r.url === url)!
  /** Calls a route handler as the given user, the way an adapter would. */
  const call = async (userId: string, method: string, url: string, args: Record<string, unknown> = {}) => {
    const { reply, state } = fakeReply()
    const out = await runWithContext({ container, user: { id: userId } } as never, () =>
      Promise.resolve(find(method, url).handler({ reply, ...args } as never)),
    )
    return { out, state }
  }
  return { files, driver, call, find }
}

describe('F36 · fileRoutes() enforce object-level authorization (owner-only by default)', () => {
  it("another user can neither list, read, sign nor delete a user's file", async () => {
    const { files, driver, call } = setup()
    const a = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'userA' })

    const listed = (await call('userB', 'GET', '/files')).out as FileRecord[]
    expect(listed.map((f) => f.id)).not.toContain(a.id)

    const got = await call('userB', 'GET', '/files/:id', { params: { id: a.id } })
    expect(got.state.status).toBe(404)

    const signed = await call('userB', 'POST', '/files/:id/url', { params: { id: a.id }, body: {} })
    expect(signed.state.status).toBe(404)
    expect((signed.out as { url?: string } | undefined)?.url).toBeUndefined()

    const deleted = await call('userB', 'DELETE', '/files/:id', { params: { id: a.id } })
    expect(deleted.state.status).toBe(404)
    expect(await files.get(a.id)).not.toBeNull()
    expect(driver.files.has(a.path)).toBe(true)
  })

  it('the owner keeps full access to their own file', async () => {
    const { files, call } = setup()
    const a = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'userA' })

    expect(((await call('userA', 'GET', '/files')).out as FileRecord[]).map((f) => f.id)).toEqual([a.id])
    expect(((await call('userA', 'GET', '/files/:id', { params: { id: a.id } })).out as FileRecord).id).toBe(a.id)
    const signed = await call('userA', 'POST', '/files/:id/url', { params: { id: a.id }, body: { expiresIn: '5m' } })
    expect((signed.out as { url: string }).url).toContain('e=300000')
    expect((await call('userA', 'DELETE', '/files/:id', { params: { id: a.id } })).state.status).toBe(204)
    expect(await files.get(a.id)).toBeNull()
  })

  it('a file with no recorded uploader is not reachable through the default routes', async () => {
    const { files, call } = setup()
    const system = await files.upload(png, { name: 'sys.pdf', contentType: 'application/pdf' })
    expect(((await call('userA', 'GET', '/files')).out as FileRecord[]).length).toBe(0)
    expect((await call('userA', 'GET', '/files/:id', { params: { id: system.id } })).state.status).toBe(404)
  })

  it('shared: true is the explicit opt-in for a scope-wide drive', async () => {
    const { files, call } = setup({ shared: true })
    const a = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'userA' })
    expect(((await call('userB', 'GET', '/files')).out as FileRecord[]).map((f) => f.id)).toEqual([a.id])
    expect((await call('userB', 'DELETE', '/files/:id', { params: { id: a.id } })).state.status).toBe(204)
  })

  it('an authorize hook decides per action and per record', async () => {
    const seen: string[] = []
    const { files, call } = setup({
      authorize: (action, record, user) => {
        seen.push(`${action}:${user.id}`)
        return action === 'read' || record.uploadedBy === user.id
      },
    })
    const a = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'userA' })
    expect(((await call('userB', 'GET', '/files')).out as FileRecord[]).map((f) => f.id)).toEqual([a.id])
    expect((await call('userB', 'DELETE', '/files/:id', { params: { id: a.id } })).state.status).toBe(404)
    expect(seen).toContain('delete:userB')
  })

  it('a request with no user is refused (401)', async () => {
    const { files, find } = setup()
    const a = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'userA' })
    const container = new Container()
    container.singleton(FILES, () => files)
    await expect(
      runWithContext({ container } as never, () =>
        Promise.resolve(find('GET', '/files/:id').handler({ params: { id: a.id }, reply: fakeReply().reply } as never)),
      ),
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe('F36 · POST /files/:id/url bounds the signed URL lifetime', () => {
  const schema = () => fileRoutes().find((r) => r.method === 'POST' && r.url === '/files/:id/url')!.body!

  it('rejects an expiry beyond the cap, a malformed expiry and a zero expiry at validation (400)', () => {
    expect(schema().safeParse({ expiresIn: '10y' }).success).toBe(false)
    expect(schema().safeParse({ expiresIn: '365d' }).success).toBe(false)
    expect(schema().safeParse({ expiresIn: '2h' }).success).toBe(false)
    expect(schema().safeParse({ expiresIn: '0s' }).success).toBe(false)
    expect(schema().safeParse({ expiresIn: 'forever' }).success).toBe(false)
    expect(schema().safeParse({ expiresIn: '1h' }).success).toBe(true)
    expect(schema().safeParse({ expiresIn: '15m' }).success).toBe(true)
    expect(schema().safeParse({}).success).toBe(true)
  })

  it('maxUrlTtl raises or lowers the cap explicitly', () => {
    const body = fileRoutes({ maxUrlTtl: '5m' }).find((r) => r.url === '/files/:id/url')!.body!
    expect(body.safeParse({ expiresIn: '10m' }).success).toBe(false)
    expect(body.safeParse({ expiresIn: '5m' }).success).toBe(true)
  })

  it('omitting expiresIn never signs past a lower maxUrlTtl', async () => {
    // The default lifetime (15m) must not slip past a stricter cap: a client
    // that leaves expiresIn out would otherwise get a URL longer than the app allows.
    const { files, call } = setup({ maxUrlTtl: '5m' })
    const record = await files.upload(png, { name: 'a.pdf', contentType: 'application/pdf', uploadedBy: 'u1' })
    for (const body of [undefined, {}]) {
      const { out } = await call('u1', 'POST', '/files/:id/url', { params: { id: record.id }, body })
      expect((out as { url: string }).url).toBe(`https://fake/files/${record.id}?e=${5 * 60_000}`)
    }
  })
})

describe('F59 · an explicit tenantId never widens past the context tenant', () => {
  it('refuses a tenantId that differs from the ambient tenant, on every operation', async () => {
    const files = new Files({ disk: new Disk('uploads', new FakeDriver()) }, () => true)
    const globex = await files.upload(png, { name: 'g.pdf', contentType: 'application/pdf', tenantId: 'globex' })

    const inAcme = <T>(fn: () => Promise<T>) => runWithContext({ tenant: { id: 'acme' } } as never, fn)
    await expect(inAcme(() => files.list('globex'))).rejects.toBeInstanceOf(FileTenantMismatchError)
    await expect(inAcme(() => files.get(globex.id, 'globex'))).rejects.toBeInstanceOf(FileTenantMismatchError)
    await expect(inAcme(() => files.download(globex.id, 'globex'))).rejects.toBeInstanceOf(FileTenantMismatchError)
    await expect(inAcme(() => files.temporaryUrl(globex.id, '5m', 'globex'))).rejects.toBeInstanceOf(FileTenantMismatchError)
    await expect(inAcme(() => files.delete(globex.id, 'globex'))).rejects.toBeInstanceOf(FileTenantMismatchError)
    await expect(
      inAcme(() => files.upload(png, { name: 'x.pdf', contentType: 'application/pdf', tenantId: 'globex' })),
    ).rejects.toBeInstanceOf(FileTenantMismatchError)
    expect(await files.get(globex.id, 'globex')).not.toBeNull()

    // Matching the ambient tenant, or omitting it, still works.
    expect(await inAcme(() => files.list('acme'))).toEqual([])
    expect(await inAcme(() => files.list())).toEqual([])
  })
})

describe('F74 · maxTotalBytes holds under concurrent uploads', () => {
  it('parallel uploads cannot exceed the per-tenant quota', async () => {
    const store = new MemoryFileStore()
    const files = new Files({ disk: new Disk('uploads', new FakeDriver()), store, maxTotalBytes: 1000 })
    const chunk = Buffer.alloc(100)
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => files.upload(chunk, { name: `f${i}`, contentType: 'text/plain', tenantId: 'acme' })),
    )
    expect(await store.totalSize('acme')).toBeLessThanOrEqual(1000)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StorageQuotaExceededError)
  })

  it('a store shared across processes is re-checked after insert and the overrun rolled back', async () => {
    // Simulates another instance writing between our check and our insert.
    const store = new MemoryFileStore()
    const driver = new FakeDriver()
    let raced = false
    const original = store.create.bind(store)
    store.create = async (record) => {
      if (!raced) {
        raced = true
        await original({ ...record, id: 'other-instance', size: 950 })
      }
      return original(record)
    }
    const files = new Files({ disk: new Disk('uploads', driver), store, maxTotalBytes: 1000 })
    await expect(files.upload(Buffer.alloc(100), { name: 'x', contentType: 'text/plain', tenantId: 'acme' })).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    )
    expect(await store.totalSize('acme')).toBe(950)
    expect([...driver.files.keys()]).toEqual([])
  })
})

describe('MemoryFileStore keys cannot collide across tenants', () => {
  it('a tenant id containing the separator does not reach another tenant record', async () => {
    const store = new MemoryFileStore()
    const record = { id: 'uuid-1', tenantId: 'a b', name: 'n', contentType: 't', size: 1, path: 'p', checksum: 'c', createdAt: 0 }
    await store.create(record)
    expect(await store.find('a', 'b uuid-1')).toBeNull()
    expect(await store.find('a b', 'uuid-1')).not.toBeNull()
  })
})
