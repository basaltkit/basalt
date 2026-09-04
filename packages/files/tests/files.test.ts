import { describe, expect, it } from 'vitest'
import { HookBus, runWithContext } from '@basaltkit/core'
import { Disk, type StorageDriver } from '@basaltkit/storage'
import {
  DEFAULT_MAX_FILE_SIZE,
  FileNotFoundError,
  FileTenantRequiredError,
  SINGLE_TENANT_SCOPE,
  FileTooLargeError,
  FileTypeNotAllowedError,
  Files,
  StorageQuotaExceededError,
  type FileRecord,
} from '../src/index.js'

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

function setup(options: Partial<ConstructorParameters<typeof Files>[0]> = {}) {
  const driver = new FakeDriver()
  const disk = new Disk('uploads', driver)
  const hooks = new HookBus()
  const files = new Files({ disk, hooks, ...options })
  return { driver, files, hooks }
}

const png = Buffer.from('fake-png-bytes')

describe('Files.upload', () => {
  it('stores the bytes (tenant-scoped) and records metadata', async () => {
    const { driver, files, hooks } = setup()
    let uploaded: FileRecord | undefined
    hooks.on('file:uploaded', (p) => {
      uploaded = (p as { file: FileRecord }).file
    })

    const record = await files.upload(png, { name: 'logo.png', contentType: 'image/png', tenantId: 'acme', uploadedBy: 'u1' })
    expect(record).toMatchObject({ tenantId: 'acme', name: 'logo.png', contentType: 'image/png', size: png.length, uploadedBy: 'u1' })
    expect(record.checksum).toHaveLength(64)
    // bytes landed under the tenant's prefix
    expect(driver.files.has(`tenants/acme/${record.path}`)).toBe(true)
    expect(uploaded?.id).toBe(record.id)
  })

  it('validates size and content type', async () => {
    const { files } = setup({ validate: { maxSize: 5, allowedTypes: ['image/*'] } })
    await expect(files.upload(png, { name: 'big.png', contentType: 'image/png', tenantId: 'acme' })).rejects.toBeInstanceOf(FileTooLargeError)
    const { files: f2 } = setup({ validate: { allowedTypes: ['image/*'] } })
    await expect(f2.upload(png, { name: 'x.txt', contentType: 'text/plain', tenantId: 'acme' })).rejects.toBeInstanceOf(FileTypeNotAllowedError)
    // wildcard accepts a matching type
    await expect(f2.upload(png, { name: 'ok.png', contentType: 'image/png', tenantId: 'acme' })).resolves.toBeDefined()
  })

  it('enforces the per-tenant quota', async () => {
    const { files } = setup({ maxTotalBytes: png.length })
    await files.upload(png, { name: 'a.png', contentType: 'image/png', tenantId: 'acme' })
    await expect(files.upload(png, { name: 'b.png', contentType: 'image/png', tenantId: 'acme' })).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    )
    // a different tenant has its own allowance
    await expect(files.upload(png, { name: 'c.png', contentType: 'image/png', tenantId: 'globex' })).resolves.toBeDefined()
  })

  it('runs a custom quota check', async () => {
    const { files } = setup({
      checkQuota: (tenantId) => {
        if (tenantId === 'blocked') throw new StorageQuotaExceededError()
      },
    })
    await expect(files.upload(png, { name: 'x.png', contentType: 'image/png', tenantId: 'blocked' })).rejects.toBeInstanceOf(
      StorageQuotaExceededError,
    )
  })

  it('takes the tenant from the request context when omitted', async () => {
    const { files } = setup()
    const record = await runWithContext({ tenant: { id: 'acme' } } as never, () =>
      files.upload(png, { name: 'ctx.png', contentType: 'image/png' }),
    )
    expect(record.tenantId).toBe('acme')
  })

  it('with tenancy ACTIVE and no resolvable tenant, upload still fails closed', async () => {
    const { driver, hooks } = setup()
    const multiTenant = new Files({ disk: new Disk('uploads', driver), hooks }, () => true)
    await expect(multiTenant.upload(png, { name: 'x.png', contentType: 'image/png' })).rejects.toBeInstanceOf(
      FileTenantRequiredError,
    )
  })
})

describe('beyond-SaaS: files does not require tenancy', () => {
  it('with NO tenancy, the whole upload/read/delete path works unscoped', async () => {
    const { driver, files } = setup()

    const record = await files.upload(png, { name: 'a.png', contentType: 'image/png' })
    expect(record.tenantId).toBe(SINGLE_TENANT_SCOPE)
    expect(await files.list()).toHaveLength(1)
    expect((await files.get(record.id))?.name).toBe('a.png')
    expect((await files.download(record.id)).content.equals(png)).toBe(true)
    expect(await files.temporaryUrl(record.id, '5m')).toContain(record.path)
    // A timestamp, not a flag: 'scanned' with no idea when stops being an
    // answer the moment the scanner's rules change.
    const marked = await files.markScanned(record.id, { clean: true })
    expect(marked.scannedAt).toBeGreaterThan(0)

    // Storage paths stay unprefixed — identical to using @basaltkit/storage directly.
    expect(await driver.exists(record.path)).toBe(true)

    await files.delete(record.id)
    expect(await files.list()).toHaveLength(0)
  })
})

describe('Files lifecycle', () => {
  it('downloads, lists (tenant-scoped), signs a URL, marks scanned and deletes', async () => {
    const { driver, files, hooks } = setup()
    const record = await files.upload(png, { name: 'a.png', contentType: 'image/png', tenantId: 'acme' })
    await files.upload(png, { name: 'b.png', contentType: 'image/png', tenantId: 'globex' })

    // download
    const { content } = await files.download(record.id, 'acme')
    expect(content.equals(png)).toBe(true)
    await expect(files.download('missing', 'acme')).rejects.toBeInstanceOf(FileNotFoundError)

    // list is tenant-scoped
    expect((await files.list('acme')).map((f) => f.id)).toEqual([record.id])

    // signed URL
    expect(await files.temporaryUrl(record.id, '15m', 'acme')).toContain(`tenants/acme/${record.path}`)

    // scan result
    let scanned: FileRecord | undefined
    hooks.on('file:scanned', (p) => {
      scanned = (p as { file: FileRecord }).file
    })
    const marked = await files.markScanned(record.id, { clean: true }, 'acme')
    expect(marked.scannedAt).toBeGreaterThan(0)
    expect((marked.metadata as { scan?: { clean: boolean } }).scan?.clean).toBe(true)
    expect(scanned?.id).toBe(record.id)

    // delete removes bytes and record
    let deleted = false
    hooks.on('file:deleted', () => {
      deleted = true
    })
    await files.delete(record.id, 'acme')
    expect(await files.get(record.id, 'acme')).toBeNull()
    expect(driver.files.has(`tenants/acme/${record.path}`)).toBe(false)
    expect(deleted).toBe(true)
  })
})

describe('secure defaults (review 2026-08-b, S-3)', () => {
  it('uploads have a size cap even when no validate option is given', async () => {
    const { files } = setup() // NO validate — the default cap must exist
    const oversized = Buffer.alloc(DEFAULT_MAX_FILE_SIZE + 1)
    await expect(
      files.upload(oversized, { name: 'huge.bin', contentType: 'application/octet-stream', tenantId: 'acme' }),
    ).rejects.toBeInstanceOf(FileTooLargeError)
  })

  it('an explicit maxSize still overrides the default (raise or lower)', async () => {
    const { files } = setup({ validate: { maxSize: 4 } })
    await expect(
      files.upload(Buffer.alloc(5), { name: 'x.bin', contentType: 'application/octet-stream', tenantId: 'acme' }),
    ).rejects.toBeInstanceOf(FileTooLargeError)
  })
})
