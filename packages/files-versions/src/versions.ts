import { randomUUID } from 'node:crypto'
import type { HookBus } from '@basaltkit/core'
import { SINGLE_TENANT_SCOPE, type FileRecord, type Files, type UploadInput } from '@basaltkit/files'
import { MemoryFileVersionStore, type FileVersion, type FileVersionStore } from './store.js'

export interface FileVersionsOptions {
  files: Files
  store?: FileVersionStore
  hooks?: HookBus
  /** How a new group id is minted. Defaults to a random UUID. */
  newGroupId?: () => string
}

/** A revision and the file record it points at, resolved in one call. */
export interface ResolvedVersion {
  version: FileVersion
  file: FileRecord
}

export class FileVersionNotFoundError extends Error {
  readonly code = 'FILE_VERSION_NOT_FOUND'
  constructor() {
    super('No such version')
    this.name = 'FileVersionNotFoundError'
  }
}

/**
 * Revisions of a document, on top of `@basaltkit/files`.
 *
 * **Why a separate package and not a field on `FileRecord`.** A file record
 * describes bytes: their size, their checksum, where they sit on the disk.
 * A revision describes an editorial act — someone replaced the draft, and said
 * why. Putting a `version` column on the byte record would make every consumer
 * of files carry a concept most of them do not have, and would still not
 * answer the question that matters ("what did this document look like in
 * March?"), because two uploads of the same document are two unrelated records
 * with no link between them.
 *
 * Each revision points at a whole file, and old revisions keep pointing at
 * their own bytes. Nothing is overwritten, which is the point: in a law firm,
 * knowing which draft of a contract you are reading is a professional
 * obligation, not a convenience.
 */
export class FileVersions {
  private readonly files: Files
  private readonly store: FileVersionStore
  private readonly hooks: HookBus | undefined
  private readonly newGroupId: () => string

  constructor(options: FileVersionsOptions) {
    this.files = options.files
    this.store = options.store ?? new MemoryFileVersionStore()
    this.hooks = options.hooks
    this.newGroupId = options.newGroupId ?? randomUUID
  }

  /**
   * Uploads the first revision of a new document and returns its group id.
   *
   * The group id is what the application stores against its own entity — a
   * matter's contract, a client's mandate — and it never changes again.
   */
  async create(
    content: Buffer,
    input: UploadInput & { note?: string },
  ): Promise<ResolvedVersion & { groupId: string }> {
    const groupId = this.newGroupId()
    const resolved = await this.addVersion(groupId, content, input)
    return { ...resolved, groupId }
  }

  /**
   * Uploads a new revision of an existing document.
   *
   * The previous revision is untouched — it keeps its own file, its own bytes
   * and its own place in the history.
   */
  async addVersion(
    groupId: string,
    content: Buffer,
    input: UploadInput & { note?: string },
  ): Promise<ResolvedVersion> {
    const file = await this.files.upload(content, input)
    const version = await this.store.append(file.tenantId, groupId, file.id, {
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.uploadedBy !== undefined ? { by: input.uploadedBy } : {}),
    })
    await this.hooks?.emit('file-version:added', { version, file })
    return { version, file }
  }

  /**
   * The current revision of a document, with its file.
   *
   * `tenantId` is optional and last, mirroring `Files` — and for the same
   * reason. `SINGLE_TENANT_SCOPE` is a **store key**, not a tenant id: passing
   * it back as one puts a single-tenant app's reads inside a tenant context,
   * where the disk prefixes every path and the bytes are not.
   */
  async latest(groupId: string, tenantId?: string): Promise<ResolvedVersion | null> {
    const version = await this.store.latest(this.scope(tenantId), groupId)
    return version ? this.resolve(version, tenantId) : null
  }

  /** One revision by number, with its file. */
  async at(groupId: string, n: number, tenantId?: string): Promise<ResolvedVersion | null> {
    const version = await this.store.at(this.scope(tenantId), groupId, n)
    return version ? this.resolve(version, tenantId) : null
  }

  /** Every revision, newest first. Versions only — no file lookups. */
  async history(groupId: string, tenantId?: string): Promise<FileVersion[]> {
    return this.store.history(this.scope(tenantId), groupId)
  }

  /** Downloads a specific revision's bytes. Defaults to the current one. */
  async download(
    groupId: string,
    n?: number,
    tenantId?: string,
  ): Promise<{ version: FileVersion; record: FileRecord; content: Buffer }> {
    const resolved = n === undefined ? await this.latest(groupId, tenantId) : await this.at(groupId, n, tenantId)
    if (!resolved) throw new FileVersionNotFoundError()
    const { record, content } = await this.files.download(resolved.version.fileId, tenantId)
    return { version: resolved.version, record, content }
  }

  /**
   * The version store's key for a call: the tenant, or the same single-tenant
   * scope `FileStore` uses, so both stores are keyed identically.
   */
  private scope(tenantId?: string): string {
    return tenantId ?? SINGLE_TENANT_SCOPE
  }

  /**
   * A revision whose file is gone is a dangling row, and returning it as if it
   * were readable would push the failure to whoever tries to download it.
   */
  private async resolve(version: FileVersion, tenantId?: string): Promise<ResolvedVersion> {
    const file = await this.files.get(version.fileId, tenantId)
    if (!file) throw new FileVersionNotFoundError()
    return { version, file }
  }
}
