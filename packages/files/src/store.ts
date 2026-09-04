/**
 * A value that survives a round trip through JSON — and therefore through a
 * database's JSON column.
 *
 * `Record<string, unknown>` did not: every durable store had to cast its way
 * past the driver's own JSON type, which is a cast each implementation would
 * have had to repeat and get right. Saying what the column actually holds costs
 * nothing at the call site, because an object literal of strings, numbers and
 * nested objects already satisfies it.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Free-form metadata attached to a file record. */
export type FileMetadata = Record<string, JsonValue>

/** Metadata for one uploaded file. The bytes live in storage; this is the record. */
export interface FileRecord {
  id: string
  tenantId: string
  /** Original filename. */
  name: string
  contentType: string
  /** Size in bytes. */
  size: number
  /** Path within the storage disk. */
  path: string
  /** SHA-256 of the content. */
  checksum: string
  uploadedBy?: string
  metadata?: FileMetadata
  /**
   * When a scanning step (antivirus, moderation, …) last reported on this file,
   * set by `markScanned`. Absent means never scanned.
   *
   * A timestamp rather than the `scanned: boolean` this replaced: the date
   * derives the boolean, and the boolean does not derive the date. "Scanned"
   * with no idea when stops being an answer the moment the scanner's rules
   * change — which is the one thing antivirus rules reliably do.
   */
  scannedAt?: number
  createdAt: number
}

/**
 * The fields of a file record that can change after it is written.
 *
 * Spelled out rather than derived with `Partial<Pick<…>>` so it can say the one
 * thing that matters to a durable store: **a key present with `undefined`
 * clears the column, a key that is absent leaves it alone.** That is how a
 * caller drops a stale scan result, and `Partial` of an optional field cannot
 * express it under `exactOptionalPropertyTypes`.
 */
export interface FilePatch {
  scannedAt?: number | undefined
  metadata?: FileMetadata | undefined
}

/** Where file metadata lives — the app's database in production. */
export interface FileStore {
  create(record: FileRecord): Promise<void>
  find(tenantId: string, id: string): Promise<FileRecord | null>
  list(tenantId: string): Promise<FileRecord[]>
  update(tenantId: string, id: string, patch: FilePatch): Promise<FileRecord | null>
  delete(tenantId: string, id: string): Promise<void>
  /** Total bytes stored by a tenant — used for quota checks. */
  totalSize(tenantId: string): Promise<number>
}

export class MemoryFileStore implements FileStore {
  private readonly records = new Map<string, FileRecord>()
  private key(tenantId: string, id: string): string {
    return `${tenantId} ${id}`
  }

  async create(record: FileRecord): Promise<void> {
    this.records.set(this.key(record.tenantId, record.id), record)
  }
  async find(tenantId: string, id: string): Promise<FileRecord | null> {
    return this.records.get(this.key(tenantId, id)) ?? null
  }
  async list(tenantId: string): Promise<FileRecord[]> {
    const out: FileRecord[] = []
    for (const record of this.records.values()) if (record.tenantId === tenantId) out.push(record)
    return out
  }
  async update(tenantId: string, id: string, patch: FilePatch): Promise<FileRecord | null> {
    const record = this.records.get(this.key(tenantId, id))
    if (!record) return null
    Object.assign(record, patch)
    return record
  }
  async delete(tenantId: string, id: string): Promise<void> {
    this.records.delete(this.key(tenantId, id))
  }
  async totalSize(tenantId: string): Promise<number> {
    let total = 0
    for (const record of this.records.values()) if (record.tenantId === tenantId) total += record.size
    return total
  }
}
