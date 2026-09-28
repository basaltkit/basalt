import type { Comment, CommentPatch, CommentStore } from '@basaltkit/comments'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/comments-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/comments` `CommentStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `Comment` model (see the bundled `prisma/schema.prisma`).
 * The production counterpart to `@basaltkit/comments-sqlite`.
 */

interface PComment {
  tenantId: string
  id: string
  resourceType: string
  resourceId: string
  parentId: string | null
  authorId: string
  body: string
  mentions: string[]
  resolvedAt: Date | null
  resolvedBy: string | null
  editedAt: Date | null
  createdAt: Date
}

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with the `Comment` model is assignable, so pass it directly. Method arguments
 * are typed `any` (Prisma's generated method generics can't be reproduced by a
 * hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaCommentsClient {
  comment: {
    findUnique(a: any): Promise<PComment | null>
    findMany(a: any): Promise<PComment[]>
    create(a: any): Promise<PComment>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)

const toComment = (r: PComment): Comment => {
  const c: Comment = {
    id: r.id,
    tenantId: r.tenantId,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
    authorId: r.authorId,
    body: r.body,
    // `String[]` on PostgreSQL, a JSON array on MySQL (schema.mysql.prisma).
    mentions: Array.isArray(r.mentions) ? r.mentions : [],
    createdAt: ms(r.createdAt),
  }
  if (r.parentId !== null) c.parentId = r.parentId
  if (r.resolvedAt !== null) c.resolvedAt = ms(r.resolvedAt)
  if (r.resolvedBy !== null) c.resolvedBy = r.resolvedBy
  if (r.editedAt !== null) c.editedAt = ms(r.editedAt)
  return c
}

/** The `Comment` columns the store writes as strings. */
export type CommentColumn =
  | 'tenantId'
  | 'id'
  | 'resourceType'
  | 'resourceId'
  | 'parentId'
  | 'authorId'
  | 'body'
  | 'resolvedBy'

export type CommentsColumnLimits = ColumnLimits<{ Comment: CommentColumn }>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Spread it to override one column after widening it.
 */
export const commentsMysqlColumnLimits: CommentsColumnLimits = {
  Comment: {
    tenantId: V,
    id: V,
    resourceType: V,
    resourceId: V,
    parentId: V,
    authorId: V,
    body: MYSQL_TEXT,
    resolvedBy: V,
  },
}

export interface PrismaCommentStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a long
   * comment is saved cut short and the author is told it was saved.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and SQLite
   * store any length).
   */
  columnLimits?: 'mysql' | CommentsColumnLimits
}

export class PrismaCommentStore implements CommentStore {
  private readonly limits: CommentsColumnLimits | undefined

  constructor(
    private readonly client: PrismaCommentsClient,
    options: PrismaCommentStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, commentsMysqlColumnLimits)
  }

  async create(comment: Comment): Promise<void> {
    const data = {
      tenantId: comment.tenantId,
      id: comment.id,
      resourceType: comment.resourceType,
      resourceId: comment.resourceId,
      parentId: comment.parentId ?? null,
      authorId: comment.authorId,
      body: comment.body,
      mentions: comment.mentions,
      resolvedAt: comment.resolvedAt !== undefined ? at(comment.resolvedAt) : null,
      resolvedBy: comment.resolvedBy ?? null,
      editedAt: comment.editedAt !== undefined ? at(comment.editedAt) : null,
      createdAt: at(comment.createdAt),
    }
    assertColumnLengths(PKG, this.limits, 'Comment', data)
    await this.client.comment.create({ data })
  }

  async find(tenantId: string, id: string): Promise<Comment | null> {
    const r = await this.client.comment.findUnique({ where: { tenantId_id: { tenantId, id } } })
    return r ? toComment(r) : null
  }

  async list(tenantId: string, resourceType: string, resourceId: string): Promise<Comment[]> {
    const rows = await this.client.comment.findMany({
      where: { tenantId, resourceType, resourceId },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map(toComment)
  }

  async update(tenantId: string, id: string, patch: CommentPatch): Promise<Comment | null> {
    // A key present in the patch is written (even if `undefined` → NULL, which is
    // how reopen clears resolvedAt/resolvedBy); an absent key is left untouched.
    const data: Record<string, unknown> = {}
    if ('body' in patch) data.body = patch.body
    if ('mentions' in patch) data.mentions = patch.mentions ?? []
    if ('editedAt' in patch) data.editedAt = patch.editedAt !== undefined ? at(patch.editedAt) : null
    if ('resolvedAt' in patch) data.resolvedAt = patch.resolvedAt !== undefined ? at(patch.resolvedAt) : null
    if ('resolvedBy' in patch) data.resolvedBy = patch.resolvedBy ?? null
    if (Object.keys(data).length > 0) {
      assertColumnLengths(PKG, this.limits, 'Comment', data)
      await this.client.comment.updateMany({ where: { tenantId, id }, data })
    }
    return this.find(tenantId, id)
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.client.comment.deleteMany({ where: { tenantId, id } })
  }
}

export interface PrismaCommentsStores {
  store: PrismaCommentStore
}

/**
 * Wire the comment store to your Prisma client, named to drop straight into
 * `commentsPlugin`:
 *
 * ```ts
 * const c = prismaCommentsStore(prisma) // on MySQL: prismaCommentsStore(prisma, { columnLimits: 'mysql' })
 * commentsPlugin({ store: c.store })
 * ```
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaCommentsStore(
  client: PrismaCommentsClient,
  options: PrismaCommentStoreOptions = {},
): PrismaCommentsStores {
  ensureModel(client, 'comment', PKG)
  return { store: new PrismaCommentStore(client, options) }
}
