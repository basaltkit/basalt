import { type ColumnLimits, MYSQL_TEXT, MYSQL_VARCHAR_DEFAULT as V } from './column-limits.js'

/** The `File` columns the store writes as strings. */
export type FileColumn = 'tenantId' | 'id' | 'name' | 'contentType' | 'path' | 'checksum' | 'uploadedBy'
/** The `FileVersion` columns the version store writes as strings. */
export type FileVersionColumn = 'tenantId' | 'groupId' | 'fileId' | 'note' | 'by'

export type FilesColumnLimits = ColumnLimits<{ File: FileColumn; FileVersion: FileVersionColumn }>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects, for both `prismaFilesStore` and `prismaFileVersionsStore`.
 * Spread it to override one column after widening it.
 */
export const filesMysqlColumnLimits: FilesColumnLimits = {
  File: {
    tenantId: V,
    id: V,
    name: MYSQL_TEXT,
    contentType: 255,
    path: MYSQL_TEXT,
    checksum: V,
    uploadedBy: V,
  },
  FileVersion: { tenantId: V, groupId: V, fileId: V, note: MYSQL_TEXT, by: V },
}

export interface PrismaFilesStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a cut
   * `path` no longer names the stored object, and its bytes are orphaned.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and SQLite
   * store any length).
   */
  columnLimits?: 'mysql' | FilesColumnLimits
}
