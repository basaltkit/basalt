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
  metadata?: Record<string, unknown>
  /** Set by a scanning step (antivirus, etc.) via `markScanned`. */
  scanned?: boolean
  createdAt: number
}

export type FilePatch = Partial<Pick<FileRecord, 'scanned' | 'metadata'>>

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
