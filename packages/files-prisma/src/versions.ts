import type { FileVersion, FileVersionStore } from '@basaltkit/files-versions'

/**
 * Prisma-backed implementation of the `@basaltkit/files-versions`
 * `FileVersionStore`. Optional: only needed if you use that package.
 *
 * A memory default loses the revision history and leaves the files behind, so
 * every past draft is still on the disk with nothing left to say which document
 * it belonged to — the worst of both, since the bytes still cost money.
 */

interface PFileVersion {
  tenantId: string
  groupId: string
  fileId: string
  version: number
  note: string | null
  by: string | null
  createdAt: Date
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaFileVersionsClient {
  fileVersion: {
    findFirst(a: any): Promise<PFileVersion | null>
    findMany(a: any): Promise<PFileVersion[]>
    create(a: any): Promise<PFileVersion>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const toVersion = (r: PFileVersion): FileVersion => {
  const v: FileVersion = {
    tenantId: r.tenantId,
    groupId: r.groupId,
    fileId: r.fileId,
    version: r.version,
    createdAt: r.createdAt.getTime(),
  }
  if (r.note !== null) v.note = r.note
  if (r.by !== null) v.by = r.by
  return v
}

export class PrismaFileVersionStore implements FileVersionStore {
  constructor(private readonly client: PrismaFileVersionsClient) {}

  /**
   * Reads the highest version and inserts the next one.
   *
   * The read-then-insert is not a race the way it looks: the primary key is
   * `[tenantId, groupId, version]`, so two uploads landing together cannot both
   * become version 3 — the second insert is refused by the database and the
   * caller sees an error, instead of both succeeding and leaving a history with
   * two revisions numbered the same. For a contract draft, a duplicate number
   * is worse than a failed upload.
   */
  async append(
    tenantId: string,
    groupId: string,
    fileId: string,
    meta: { note?: string; by?: string } = {},
  ): Promise<FileVersion> {
    const anterior = await this.client.fileVersion.findFirst({
      where: { tenantId, groupId },
      orderBy: { version: 'desc' },
    })
    const row = await this.client.fileVersion.create({
      data: {
        tenantId,
        groupId,
        fileId,
        version: (anterior?.version ?? 0) + 1,
        note: meta.note ?? null,
        by: meta.by ?? null,
        createdAt: new Date(),
      },
    })
    return toVersion(row)
  }

  async latest(tenantId: string, groupId: string): Promise<FileVersion | null> {
    const r = await this.client.fileVersion.findFirst({
      where: { tenantId, groupId },
      orderBy: { version: 'desc' },
    })
    return r ? toVersion(r) : null
  }

  async history(tenantId: string, groupId: string): Promise<FileVersion[]> {
    const rows = await this.client.fileVersion.findMany({
      where: { tenantId, groupId },
      orderBy: { version: 'desc' },
    })
    return rows.map(toVersion)
  }

  async at(tenantId: string, groupId: string, version: number): Promise<FileVersion | null> {
    const r = await this.client.fileVersion.findFirst({ where: { tenantId, groupId, version } })
    return r ? toVersion(r) : null
  }
}

/**
 * Wire the version store to your Prisma client:
 *
 * ```ts
 * fileVersionsPlugin({ store: prismaFileVersionsStore(prisma).store })
 * ```
 */
export function prismaFileVersionsStore(client: PrismaFileVersionsClient): {
  store: PrismaFileVersionStore
} {
  return { store: new PrismaFileVersionStore(client) }
}
