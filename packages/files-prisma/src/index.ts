import type { FileMetadata, FilePatch, FileRecord, FileStore } from '@basaltkit/files'

/**
 * Prisma-backed implementation of the `@basaltkit/files` `FileStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `File` model (see the bundled `prisma/schema.prisma`).
 *
 * **Why this package has to exist.** `@basaltkit/files` defaulted to
 * `MemoryFileStore`, and a memory default is harmless for a queue or a cache —
 * it loses work that can be redone. Here it loses the only link to bytes that
 * still exist: the disk key is `files/<uuid>` and the uuid lived in the process.
 * A restart leaves every uploaded file in the bucket, unreferenced and
 * unreachable, while the app reports an empty file list. Nothing errors.
 */

interface PFile {
  tenantId: string
  id: string
  name: string
  contentType: string
  size: bigint
  path: string
  checksum: string
  uploadedBy: string | null
  metadata: unknown
  scannedAt: Date | null
  createdAt: Date
}

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with the `File` model is assignable, so pass it directly. Method arguments
 * are typed `any` (Prisma's generated method generics can't be reproduced by a
 * hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaFilesClient {
  file: {
    findUnique(a: any): Promise<PFile | null>
    findMany(a: any): Promise<PFile[]>
    create(a: any): Promise<PFile>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
    aggregate(a: any): Promise<{ _sum: { size: bigint | null } }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)

const toRecord = (r: PFile): FileRecord => {
  const f: FileRecord = {
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    contentType: r.contentType,
    // Stored as BigInt because Int stops at 2 GB; a size only ever reaches the
    // application as a number, and Number.MAX_SAFE_INTEGER is 8 petabytes.
    size: Number(r.size),
    path: r.path,
    checksum: r.checksum,
    createdAt: ms(r.createdAt),
  }
  if (r.uploadedBy !== null) f.uploadedBy = r.uploadedBy
  if (r.metadata !== null && r.metadata !== undefined) f.metadata = r.metadata as FileMetadata
  if (r.scannedAt !== null) f.scannedAt = ms(r.scannedAt)
  return f
}

export class PrismaFileStore implements FileStore {
  constructor(private readonly client: PrismaFilesClient) {}

  async create(record: FileRecord): Promise<void> {
    await this.client.file.create({
      data: {
        tenantId: record.tenantId,
        id: record.id,
        name: record.name,
        contentType: record.contentType,
        size: BigInt(record.size),
        path: record.path,
        checksum: record.checksum,
        uploadedBy: record.uploadedBy ?? null,
        metadata: record.metadata ?? null,
        scannedAt: record.scannedAt !== undefined ? at(record.scannedAt) : null,
        createdAt: at(record.createdAt),
      },
    })
  }

  async find(tenantId: string, id: string): Promise<FileRecord | null> {
    const r = await this.client.file.findUnique({ where: { tenantId_id: { tenantId, id } } })
    return r ? toRecord(r) : null
  }

  async list(tenantId: string): Promise<FileRecord[]> {
    const rows = await this.client.file.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map(toRecord)
  }

  async update(tenantId: string, id: string, patch: FilePatch): Promise<FileRecord | null> {
    // A key present in the patch is written even when its value is `undefined`,
    // which is how a caller clears a scan result; an absent key is untouched.
    const data: Record<string, unknown> = {}
    if ('metadata' in patch) data.metadata = patch.metadata ?? null
    if ('scannedAt' in patch) {
      data.scannedAt = patch.scannedAt !== undefined ? at(patch.scannedAt) : null
    }
    if (Object.keys(data).length > 0) {
      await this.client.file.updateMany({ where: { tenantId, id }, data })
    }
    return this.find(tenantId, id)
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.client.file.deleteMany({ where: { tenantId, id } })
  }

  /**
   * Summed in the database rather than by listing and adding up in JS: a quota
   * check runs on every upload, and a tenant with fifty thousand files should
   * not move fifty thousand rows across the wire to learn one number.
   */
  async totalSize(tenantId: string): Promise<number> {
    const { _sum } = await this.client.file.aggregate({
      where: { tenantId },
      _sum: { size: true },
    })
    return Number(_sum.size ?? 0n)
  }
}

export interface PrismaFilesStores {
  store: PrismaFileStore
}

/**
 * Wire the file store to your Prisma client, named to drop straight into
 * `filesPlugin`:
 *
 * ```ts
 * const f = prismaFilesStore(prisma)
 * filesPlugin({ disk, store: f.store })
 * ```
 */
export function prismaFilesStore(client: PrismaFilesClient): PrismaFilesStores {
  return { store: new PrismaFileStore(client) }
}
