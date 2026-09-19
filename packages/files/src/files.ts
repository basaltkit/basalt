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
import {
  SNIFF_WINDOW,
  isCompatibleType,
  isSignatureType,
  normalizeContentType,
  sniffContentType,
  type ContentSniffer,
} from './sniff.js'

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

/**
 * The bytes are not what the client declared: an HTML page sent as
 * `application/pdf`, an executable sent as `image/jpeg`. Raised only with
 * `validate.sniff` on.
 */
export class FileTypeMismatchError extends BasaltError {
  readonly status = 415
  constructor(
    readonly declared: string,
    readonly detected: string | null,
  ) {
    super(
      'FILE_TYPE_MISMATCH',
      detected === null
        ? `Declared content type "${declared}" does not match the file's content.`
        : `Declared content type "${declared}" does not match the file's content ("${detected}").`,
    )
  }
}

/**
 * `requireScan` is on and no scan has reported this file clean yet. Retry once
 * the scanner has run (`markScanned`).
 */
export class FileNotScannedError extends BasaltError {
  readonly status = 423
  constructor() {
    super('FILE_NOT_SCANNED', 'File is quarantined until it has been scanned.')
  }
}

/** `requireScan` is on and the last scan reported this file as not clean. It is never served. */
export class FileInfectedError extends BasaltError {
  readonly status = 403
  constructor() {
    super('FILE_INFECTED', 'File failed its scan and cannot be served.')
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

/**
 * An explicit `tenantId` named a different tenant than the one the call runs
 * in. The context tenant is authoritative; an argument may narrow to it, never
 * widen past it.
 */
export class FileTenantMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super('FILE_TENANT_MISMATCH', 'The tenantId does not match the current tenant.')
  }
}

export interface FileValidation {
  /** Max size in bytes. */
  maxSize?: number
  /** Allowed content types; supports `image/*` wildcards. */
  allowedTypes?: string[]
  /**
   * Check the real type of the bytes instead of trusting the declared one.
   *
   * `true` uses the built-in signature sniffer ({@link sniffContentType}); a
   * function is your own detector (it receives the file's first 64 KiB and
   * returns a MIME type, or `null` for "unknown"). With sniffing on, an upload
   * whose content contradicts its declared type is rejected with
   * {@link FileTypeMismatchError}, `allowedTypes` is checked against the
   * detected type, the record's `contentType` is the detected type, and the
   * declared one is kept in `metadata.declaredType`. Off by default —
   * consider enabling it whenever users upload files other users will open.
   */
  sniff?: boolean | ContentSniffer
}

/**
 * What {@link Files.upload} accepts: the whole file in memory, or a stream of
 * its bytes — a Node `Readable`, any `AsyncIterable<Uint8Array>`, or a web
 * `ReadableStream`. A stream is size-checked, hashed and sniffed as it arrives,
 * and abandoned the moment it passes `validate.maxSize`.
 */
export type UploadContent = Uint8Array | AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>

export interface FilesOptions {
  disk: Disk
  store?: FileStore
  hooks?: HookBus
  validate?: FileValidation
  /** Max total bytes per tenant (a built-in quota). */
  maxTotalBytes?: number
  /** Custom quota check — throw to reject (e.g. wire @basaltkit/subscriptions). */
  checkQuota?: (tenantId: string, size: number) => Promise<void> | void
  /**
   * Quarantine until scanned: `download()` and `temporaryUrl()` throw
   * {@link FileNotScannedError} (423) until `markScanned` reports the file
   * clean, and {@link FileInfectedError} (403) once it reports it not clean.
   * Default `false` — scan results are recorded but do not gate access.
   */
  requireScan?: boolean
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
  // The context tenant wins: an explicit value is only honoured when it agrees
  // with it, or when there is no context tenant at all (jobs, CLI, scripts).
  // Letting the argument override the context let a caller that forwards
  // client input (`?tenantId=`) read and write another tenant's files.
  const ambient = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
  if (ambient) {
    if (explicit !== undefined && explicit !== ambient) throw new FileTenantMismatchError()
    return ambient
  }
  if (explicit) return explicit
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

/** An upload that passed validation: its bytes, their SHA-256, and the type to store it as. */
interface Accepted {
  content: Buffer
  checksum: string
  contentType: string
}

const isWebStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof (value as { getReader?: unknown }).getReader === 'function'

/** A web `ReadableStream` as an async iterable whose early exit cancels the stream. */
async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        return
      }
      yield value
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const toAsyncIterable = (source: Exclude<UploadContent, Uint8Array>): AsyncIterable<Uint8Array | string> =>
  isWebStream(source) ? readWebStream(source) : source

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
  private readonly requireScan: boolean
  private readonly now: () => number
  /** Per-scope tail of the upload chain — see {@link Files.serialized}. */
  private readonly quotaQueues = new Map<string, Promise<unknown>>()

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
    this.requireScan = options.requireScan === true
    this.now = options.now ?? Date.now
  }

  /**
   * Validates, enforces the quota, stores and records one file.
   *
   * `content` is a buffer or a stream ({@link UploadContent}). A stream is read
   * once: its size is enforced while it arrives (the source is cancelled past
   * `validate.maxSize`), its SHA-256 computed on the fly and — with
   * `validate.sniff` — its type checked on the first 64 KiB. The storage
   * driver contract takes whole buffers, so the accepted bytes are buffered
   * (at most `maxSize` of them) before `disk.put`.
   */
  async upload(content: UploadContent, input: UploadInput): Promise<FileRecord> {
    const tenantId = this.tenant(input.tenantId)
    const scope = tenantId ?? SINGLE_TENANT_SCOPE
    const accepted = content instanceof Uint8Array ? this.acceptBuffer(content, input) : await this.acceptStream(content, input)
    const size = accepted.content.length

    const quotaEnforced = this.maxTotalBytes !== undefined || this.checkQuota !== undefined
    const store = async (): Promise<FileRecord> => {
      await this.enforceQuota(scope, size)
      const record = await this.write(accepted, input, tenantId, scope)
      // Re-checked after the insert: the in-process queue cannot see uploads
      // handled by another instance against the same store. An overrun found
      // here is rolled back rather than kept.
      if (this.maxTotalBytes !== undefined && (await this.store.totalSize(scope)) > this.maxTotalBytes) {
        await this.store.delete(scope, record.id)
        await this.inTenant(tenantId, () => this.disk.delete(record.path))
        throw new StorageQuotaExceededError()
      }
      return record
    }

    const record = quotaEnforced ? await this.serialized(scope, store) : await store()
    await this.hooks?.emit('file:uploaded', { file: record })
    return record
  }

  private async write(
    accepted: Accepted,
    input: UploadInput,
    tenantId: string | undefined,
    scope: string,
  ): Promise<FileRecord> {
    const id = randomUUID()
    const path = storagePath(id)
    const { content, checksum, contentType } = accepted
    await this.inTenant(tenantId, () => this.disk.put(path, content, { contentType }))

    // Sniffing on: the record carries what the bytes are, and remembers the
    // claim — set last so caller metadata cannot overwrite it.
    const metadata: FileMetadata | undefined = this.validation.sniff
      ? { ...input.metadata, declaredType: input.contentType }
      : input.metadata
    const record: FileRecord = {
      id,
      tenantId: scope,
      name: input.name,
      contentType,
      size: content.length,
      path,
      checksum,
      createdAt: this.now(),
      ...(input.uploadedBy !== undefined ? { uploadedBy: input.uploadedBy } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    }
    await this.store.create(record)
    return record
  }

  /**
   * Runs quota-checked uploads of one scope one at a time.
   *
   * The quota is check-then-act: read the total, then write. Run concurrently,
   * every upload reads the same total and all of them pass, so twenty parallel
   * uploads could each fit a quota that only one of them fits.
   */
  private serialized<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.quotaQueues.get(scope) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.quotaQueues.set(scope, tail)
    void tail.then(() => {
      if (this.quotaQueues.get(scope) === tail) this.quotaQueues.delete(scope)
    })
    return run
  }

  async get(id: string, tenantId?: string): Promise<FileRecord | null> {
    return this.store.find(this.scope(tenantId), id)
  }

  async list(tenantId?: string): Promise<FileRecord[]> {
    return this.store.list(this.scope(tenantId))
  }

  /**
   * The file's bytes and record. With `requireScan`, throws while the file is
   * quarantined — except for `{ bypassQuarantine: true }`, which is for the
   * scanner itself (it must read the bytes it is about to judge). Never pass it
   * on a path that serves users.
   */
  async download(
    id: string,
    tenantId?: string,
    options: { bypassQuarantine?: boolean } = {},
  ): Promise<{ record: FileRecord; content: Buffer }> {
    const resolved = this.tenant(tenantId)
    const record = await this.store.find(resolved ?? SINGLE_TENANT_SCOPE, id)
    if (!record) throw new FileNotFoundError()
    if (options.bypassQuarantine !== true) this.assertServable(record)
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
    this.assertServable(record)
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
      scannedAt: this.now(),
      metadata: { ...record.metadata, scan: { ...result } },
    }
    const updated = (await this.store.update(resolved, id, patch)) ?? record
    await this.hooks?.emit('file:scanned', { file: updated })
    return updated
  }

  /** With `requireScan`, only a file whose last scan reported it clean is served. */
  private assertServable(record: FileRecord): void {
    if (!this.requireScan) return
    const scan = record.metadata?.['scan']
    const clean = scan !== null && typeof scan === 'object' && !Array.isArray(scan) ? scan['clean'] : undefined
    if (clean === false) throw new FileInfectedError()
    // Fail closed: a timestamp without a clean verdict is not a clean scan.
    if (record.scannedAt === undefined || record.scannedAt === null || clean !== true) throw new FileNotScannedError()
  }

  private checkSize(size: number): void {
    const max = this.validation.maxSize
    if (max !== undefined && size > max) throw new FileTooLargeError(size, max)
  }

  private checkAllowed(contentType: string): void {
    if (this.validation.allowedTypes && !matchesType(contentType, this.validation.allowedTypes)) {
      throw new FileTypeNotAllowedError(contentType)
    }
  }

  /**
   * The type the file is stored as. Without sniffing, the declared type
   * (allowlisted). With it, the type the bytes' `head` proves — a declared
   * type the content contradicts is refused, and the allowlist judges the
   * detected type, not the claim.
   */
  private resolveType(declared: string, head: Uint8Array): string {
    const sniff = this.validation.sniff
    if (!sniff) {
      this.checkAllowed(declared)
      return declared
    }
    const found = (sniff === true ? sniffContentType : sniff)(head)
    let effective: string
    if (found !== null) {
      const detected = normalizeContentType(found)
      if (!isCompatibleType(declared, detected)) throw new FileTypeMismatchError(declared, detected)
      effective = detected
    } else {
      // The built-in sniffer knows these signatures: bytes it can't place are
      // not the PDF/PNG/… they claim to be (a renamed file, a truncated one).
      if (sniff === true && isSignatureType(declared)) throw new FileTypeMismatchError(declared, null)
      effective = declared
    }
    this.checkAllowed(effective)
    return effective
  }

  private acceptBuffer(content: Uint8Array, input: UploadInput): Accepted {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    this.checkSize(buffer.length)
    const contentType = this.resolveType(input.contentType, buffer.subarray(0, SNIFF_WINDOW))
    const checksum = createHash('sha256').update(buffer).digest('hex')
    return { content: buffer, checksum, contentType }
  }

  /**
   * Reads a stream once, enforcing `maxSize` as it arrives. Throwing out of the
   * `for await` returns the iterator, which destroys a Node `Readable` and
   * cancels a web `ReadableStream` — nothing past the limit is read, and
   * nothing has been written to the disk yet, so there is nothing to clean up.
   */
  private async acceptStream(source: Exclude<UploadContent, Uint8Array>, input: UploadInput): Promise<Accepted> {
    // Without sniffing the declared type is all there is: refuse it before
    // reading a single byte.
    let contentType: string | undefined = this.validation.sniff ? undefined : this.resolveType(input.contentType, new Uint8Array())
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let size = 0
    for await (const piece of toAsyncIterable(source)) {
      const chunk = typeof piece === 'string' ? Buffer.from(piece) : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)
      size += chunk.length
      this.checkSize(size)
      hash.update(chunk)
      chunks.push(chunk)
      if (contentType === undefined && size >= SNIFF_WINDOW) {
        contentType = this.resolveType(input.contentType, Buffer.concat(chunks).subarray(0, SNIFF_WINDOW))
      }
    }
    const content = Buffer.concat(chunks, size)
    contentType ??= this.resolveType(input.contentType, content.subarray(0, SNIFF_WINDOW))
    return { content, checksum: hash.digest('hex'), contentType }
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
