import { createHash, randomUUID } from 'node:crypto'
import { BasaltError, runWithContext, tryCtx, type DurationInput, type HookBus } from '@basaltkit/core'
import type { Disk } from '@basaltkit/storage'
import {
  MemoryFileStore,
  type FileMetadata,
  type FilePatch,
  type FileRecord,
  type FileStore,
} from './store.js'

/** Default upload cap (25 MiB) applied when `validate.maxSize` is not set. */
export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024

export class FileTooLargeError extends BasaltError {
  readonly status = 413
  constructor(size: number, max: number) {
    super('FILE_TOO_LARGE', `File is ${size} bytes; the limit is ${max}.`)
  }
}

export class FileTypeNotAllowedError extends BasaltError {
  readonly status = 415
  constructor(contentType: string) {
    super('FILE_TYPE_NOT_ALLOWED', `Content type "${contentType}" is not allowed.`)
  }
}

/** The tenant's storage allowance is exhausted. */
export class StorageQuotaExceededError extends BasaltError {
  readonly status = 402
  constructor() {
    super('FILE_QUOTA_EXCEEDED', 'Storage quota exceeded for this tenant.')
  }
}

export class FileNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('FILE_NOT_FOUND', 'File not found.')
  }
}

export class FileTenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('FILE_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

export interface FileValidation {
  /** Max size in bytes. */
  maxSize?: number
  /** Allowed content types; supports `image/*` wildcards. */
  allowedTypes?: string[]
}

export interface FilesOptions {
  disk: Disk
  store?: FileStore
  hooks?: HookBus
  validate?: FileValidation
  /** Max total bytes per tenant (a built-in quota). */
  maxTotalBytes?: number
  /** Custom quota check — throw to reject (e.g. wire @basaltkit/subscriptions). */
  checkQuota?: (tenantId: string, size: number) => Promise<void> | void
  now?: () => number
}

export interface UploadInput {
  name: string
  contentType: string
  tenantId?: string
  uploadedBy?: string
  metadata?: FileMetadata
}

/**
 * The tenant a file call is scoped to, or `undefined` when the app has no
 * tenancy.
 *
 * With `@basaltkit/tenancy` registered an unresolvable tenant is an error: an
 * unscoped read or write would cross tenants. Without it there is no tenant
 * dimension and nothing to cross.
 */
export function resolveFileTenant(explicit: string | undefined, tenancyActive: boolean): string | undefined {
  const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
  if (id) return id
  if (tenancyActive) throw new FileTenantRequiredError()
  return undefined
}

/**
 * The store key for a file call: the resolved tenant, or
 * {@link SINGLE_TENANT_SCOPE}.
 *
 * Exported so that anything storing rows alongside files — `FileVersions`, an
 * application's own table — keys them identically. Two implementations of this
 * rule is one implementation too many: the first divergence wrote versions
 * under the context tenant and read them back under `'default'`, which answers
 * "no such document" about a document that exists.
 */
export function fileScope(explicit: string | undefined, tenancyActive: boolean): string {
  return resolveFileTenant(explicit, tenancyActive) ?? SINGLE_TENANT_SCOPE
}

const matchesType = (contentType: string, allowed: string[]): boolean =>
  allowed.some((a) => a === contentType || (a.endsWith('/*') && contentType.startsWith(a.slice(0, -1))))

const storagePath = (id: string): string => `files/${id}`

/**
 * Store key every record is filed under when the app has no tenancy at all.
 * The {@link FileStore} contract is tenant-keyed, so a single-tenant app still
 * needs one stable key — it just shouldn't have to invent it.
 */
export const SINGLE_TENANT_SCOPE = 'default'

/**
 * Upload pipeline over a storage {@link Disk}: validates size/type, enforces a
 * per-tenant quota, writes the bytes, records metadata, and emits hooks. Every
 * operation is tenant-scoped; storage access runs in the resolved tenant's
 * context so files are isolated whether called from a request or a job.
 */
export class Files {
  private readonly disk: Disk
  private readonly store: FileStore
  private readonly hooks: HookBus | undefined
  private readonly validation: FileValidation
  private readonly maxTotalBytes: number | undefined
  private readonly checkQuota: FilesOptions['checkQuota']
  private readonly now: () => number

  constructor(
    options: FilesOptions,
    /**
     * Whether the host app registered `@basaltkit/tenancy`. `filesPlugin` wires
     * this to the container's `'tenancy:active'` metadata marker — a signal,
     * not an import, so this generic package never depends on the opt-in SaaS
     * layer. Defaults to `false` (single-tenant).
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.disk = options.disk
    this.store = options.store ?? new MemoryFileStore()
    this.hooks = options.hooks
    // Secure by default (review 2026-08-b, S-3): uploads are capped even when
    // the app configures nothing. Raise (or set Infinity) via validate.maxSize.
    this.validation = { maxSize: DEFAULT_MAX_FILE_SIZE, ...options.validate }
    this.maxTotalBytes = options.maxTotalBytes
    this.checkQuota = options.checkQuota
    this.now = options.now ?? Date.now
  }

  async upload(content: Buffer, input: UploadInput): Promise<FileRecord> {
    const tenantId = this.tenant(input.tenantId)
    const scope = tenantId ?? SINGLE_TENANT_SCOPE
    const size = content.length
    this.validate(input.contentType, size)
    await this.enforceQuota(scope, size)

    const id = randomUUID()
    const path = storagePath(id)
    const checksum = createHash('sha256').update(content).digest('hex')
    await this.inTenant(tenantId, () => this.disk.put(path, content, { contentType: input.contentType }))

    const record: FileRecord = {
      id,
      tenantId: scope,
      name: input.name,
      contentType: input.contentType,
      size,
      path,
      checksum,
      createdAt: this.now(),
      ...(input.uploadedBy !== undefined ? { uploadedBy: input.uploadedBy } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    await this.store.create(record)
    await this.hooks?.emit('file:uploaded', { file: record })
    return record
  }

  async get(id: string, tenantId?: string): Promise<FileRecord | null> {
    return this.store.find(this.scope(tenantId), id)
  }

  async list(tenantId?: string): Promise<FileRecord[]> {
    return this.store.list(this.scope(tenantId))
  }

  async download(id: string, tenantId?: string): Promise<{ record: FileRecord; content: Buffer }> {
    const resolved = this.tenant(tenantId)
    const record = await this.store.find(resolved ?? SINGLE_TENANT_SCOPE, id)
    if (!record) throw new FileNotFoundError()
    const content = await this.inTenant(resolved, () => this.disk.get(record.path))
    return { record, content }
  }

  /**
   * Signed download URL — served `Content-Disposition: attachment` by default
   * so an uploaded HTML/SVG file can never render top-level on the storage
   * origin; pass `{ disposition: 'inline' }` when in-browser rendering is
   * deliberate (embedded <img>/<video> uses render regardless).
   */
  async temporaryUrl(
    id: string,
    expiresIn: DurationInput,
    tenantId?: string,
    options: { disposition?: 'attachment' | 'inline' } = {},
  ): Promise<string> {
    const resolved = this.tenant(tenantId)
    const record = await this.store.find(resolved ?? SINGLE_TENANT_SCOPE, id)
    if (!record) throw new FileNotFoundError()
    return this.inTenant(resolved, () => this.disk.temporaryUrl(record.path, expiresIn, options))
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const resolved = this.tenant(tenantId)
    const scope = resolved ?? SINGLE_TENANT_SCOPE
    const record = await this.store.find(scope, id)
    if (!record) return
    await this.inTenant(resolved, () => this.disk.delete(record.path))
    await this.store.delete(scope, id)
    await this.hooks?.emit('file:deleted', { tenantId: scope, id })
  }

  /** Records the result of an out-of-band scan (antivirus, moderation, …). */
  async markScanned(id: string, result: { clean: boolean; detail?: string }, tenantId?: string): Promise<FileRecord> {
    const resolved = this.scope(tenantId)
    const record = await this.store.find(resolved, id)
    if (!record) throw new FileNotFoundError()
    const patch: FilePatch = {
      scannedAt: Date.now(),
      metadata: { ...record.metadata, scan: { ...result } },
    }
    const updated = (await this.store.update(resolved, id, patch)) ?? record
    await this.hooks?.emit('file:scanned', { file: updated })
    return updated
  }

  private validate(contentType: string, size: number): void {
    if (this.validation.maxSize !== undefined && size > this.validation.maxSize) {
      throw new FileTooLargeError(size, this.validation.maxSize)
    }
    if (this.validation.allowedTypes && !matchesType(contentType, this.validation.allowedTypes)) {
      throw new FileTypeNotAllowedError(contentType)
    }
  }

  private async enforceQuota(tenantId: string, size: number): Promise<void> {
    if (this.maxTotalBytes !== undefined) {
      const total = await this.store.totalSize(tenantId)
      if (total + size > this.maxTotalBytes) throw new StorageQuotaExceededError()
    }
    await this.checkQuota?.(tenantId, size)
  }

  private tenant(explicit?: string): string | undefined {
    return resolveFileTenant(explicit, this.tenancyActive())
  }

  /** The {@link FileStore} key: the tenant, or {@link SINGLE_TENANT_SCOPE}. */
  private scope(explicit?: string): string {
    return fileScope(explicit, this.tenancyActive())
  }

  /**
   * Runs a storage op in the resolved tenant's context so the disk scopes
   * correctly. With no tenancy there is no tenant context to synthesize — the
   * disk keeps its own (unscoped) default, so paths match plain `@basaltkit/storage`.
   */
  private inTenant<T>(tenantId: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (tenantId === undefined) return fn()
    return runWithContext({ tenant: { id: tenantId } } as never, fn)
  }
}
