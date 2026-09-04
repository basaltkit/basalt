/**
 * One revision of a document.
 *
 * A version points at a file rather than containing it. `@basaltkit/files`
 * already owns bytes, checksums, quotas and scanning; repeating any of that
 * here would mean two records that can disagree about the same upload.
 */
export interface FileVersion {
  tenantId: string
  /** The document this revision belongs to — stable across every revision. */
  groupId: string
  /** The `FileRecord` holding this revision's bytes. */
  fileId: string
  /** 1 for the first revision, then 2, 3 … Assigned by the store, never by the caller. */
  version: number
  /** What changed, in the author's words. */
  note?: string
  /** Who uploaded this revision. */
  by?: string
  createdAt: number
}

/**
 * Where the revision history lives.
 *
 * **Every method is scoped by tenant, and that is not decoration.** The obvious
 * signature — `history(groupId)` — reads one firm's document history from
 * another firm's session the moment a group id leaks into a URL. A group id is
 * exactly the kind of value that ends up in a URL.
 */
export interface FileVersionStore {
  /**
   * Records a new revision and returns it with the version number it was given.
   *
   * The number is the store's to assign: a caller that reads the latest and
   * adds one has a race, and two uploads landing together would both claim the
   * same revision — of a contract, in a business where which draft you are
   * reading is the whole question.
   */
  append(
    tenantId: string,
    groupId: string,
    fileId: string,
    meta?: { note?: string; by?: string },
  ): Promise<FileVersion>
  /** The current revision, or null for a group that has none. */
  latest(tenantId: string, groupId: string): Promise<FileVersion | null>
  /** Every revision, newest first. */
  history(tenantId: string, groupId: string): Promise<FileVersion[]>
  /** One revision by number, or null. */
  at(tenantId: string, groupId: string, version: number): Promise<FileVersion | null>
}

export class MemoryFileVersionStore implements FileVersionStore {
  private readonly rows: FileVersion[] = []

  private scoped(tenantId: string, groupId: string): FileVersion[] {
    return this.rows.filter((r) => r.tenantId === tenantId && r.groupId === groupId)
  }

  async append(
    tenantId: string,
    groupId: string,
    fileId: string,
    meta: { note?: string; by?: string } = {},
  ): Promise<FileVersion> {
    const anteriores = this.scoped(tenantId, groupId)
    const row: FileVersion = {
      tenantId,
      groupId,
      fileId,
      version: anteriores.length === 0 ? 1 : Math.max(...anteriores.map((r) => r.version)) + 1,
      ...(meta.note !== undefined ? { note: meta.note } : {}),
      ...(meta.by !== undefined ? { by: meta.by } : {}),
      createdAt: Date.now(),
    }
    this.rows.push(row)
    return row
  }

  async latest(tenantId: string, groupId: string): Promise<FileVersion | null> {
    const rows = this.scoped(tenantId, groupId)
    if (rows.length === 0) return null
    return rows.reduce((a, b) => (b.version > a.version ? b : a))
  }

  async history(tenantId: string, groupId: string): Promise<FileVersion[]> {
    return this.scoped(tenantId, groupId).sort((a, b) => b.version - a.version)
  }

  async at(tenantId: string, groupId: string, version: number): Promise<FileVersion | null> {
    return this.scoped(tenantId, groupId).find((r) => r.version === version) ?? null
  }
}
