// esbuild strips the `node:` prefix from a static `node:sqlite` import — it's a
// newer builtin it doesn't recognize — and emits a broken `from "sqlite"`. Load
// it through an opaque specifier so the bundler leaves it exactly as written.
const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')
type DatabaseSync = InstanceType<typeof DatabaseSync>
import type { Comment, CommentPatch, CommentRevision, CommentStore } from '@basaltkit/comments'

/**
 * Durable, SQLite-backed implementation of the `@basaltkit/comments`
 * `CommentStore`, on Node's built-in `node:sqlite`. Zero external dependencies.
 * The single-node reference backend; the production (Postgres/MySQL) counterpart
 * is `@basaltkit/comments-prisma`.
 *
 * Requires Node 22.5+ (stable and flag-free on Node 24; `--experimental-sqlite`
 * on 22.x).
 */

type Bindable = null | number | bigint | string | Uint8Array
const orNull = <T extends Bindable>(v: T | undefined): T | null => (v === undefined ? null : v)

export function openCommentsDatabase(location = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(location)
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL')
  // Wait up to 5s for a competing writer's lock instead of throwing
  // 'database is locked' immediately — smooths over dev reloads / concurrency.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      tenant_id     TEXT NOT NULL,
      id            TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id   TEXT NOT NULL,
      parent_id     TEXT,
      author_id     TEXT NOT NULL,
      body          TEXT NOT NULL,
      mentions      TEXT NOT NULL,
      resolved_at   INTEGER,
      resolved_by   TEXT,
      edited_at     INTEGER,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_comments_resource ON comments (tenant_id, resource_type, resource_id);
    CREATE TABLE IF NOT EXISTS comment_revisions (
      tenant_id  TEXT NOT NULL,
      id         TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      body       TEXT NOT NULL,
      at         INTEGER NOT NULL,
      by         TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_comment_revisions ON comment_revisions (tenant_id, comment_id, at);
  `)
  // Columns added after the table first shipped: a database created by an
  // older version gets them here, so upgrading needs no manual step.
  const columns = new Set(
    (db.prepare('PRAGMA table_info(comments)').all() as unknown as { name: string }[]).map((c) => c.name),
  )
  for (const [name, type] of [
    ['anchor', 'TEXT'],
    ['deleted_at', 'INTEGER'],
    ['deleted_by', 'TEXT'],
    ['delete_reason', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE comments ADD COLUMN ${name} ${type}`)
  }
}

interface CommentRow {
  tenant_id: string
  id: string
  resource_type: string
  resource_id: string
  parent_id: string | null
  author_id: string
  body: string
  mentions: string
  resolved_at: number | null
  resolved_by: string | null
  edited_at: number | null
  created_at: number
  anchor: string | null
  deleted_at: number | null
  deleted_by: string | null
  delete_reason: string | null
}

const toComment = (r: CommentRow): Comment => {
  const c: Comment = {
    id: r.id,
    tenantId: r.tenant_id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    authorId: r.author_id,
    body: r.body,
    mentions: JSON.parse(r.mentions) as string[],
    createdAt: r.created_at,
  }
  if (r.parent_id !== null) c.parentId = r.parent_id
  if (r.resolved_at !== null) c.resolvedAt = r.resolved_at
  if (r.resolved_by !== null) c.resolvedBy = r.resolved_by
  if (r.edited_at !== null) c.editedAt = r.edited_at
  if (r.anchor !== null) c.anchor = JSON.parse(r.anchor) as Record<string, unknown>
  if (r.deleted_at !== null) c.deletedAt = r.deleted_at
  if (r.deleted_by !== null) c.deletedBy = r.deleted_by
  if (r.delete_reason !== null) c.deleteReason = r.delete_reason
  return c
}

export class SqliteCommentStore implements CommentStore {
  constructor(private readonly db: DatabaseSync) {}

  async create(comment: Comment): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO comments
           (tenant_id, id, resource_type, resource_id, parent_id, author_id, body, mentions, resolved_at, resolved_by, edited_at, created_at,
            anchor, deleted_at, deleted_by, delete_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.tenantId,
        comment.id,
        comment.resourceType,
        comment.resourceId,
        orNull(comment.parentId),
        comment.authorId,
        comment.body,
        JSON.stringify(comment.mentions),
        orNull(comment.resolvedAt),
        orNull(comment.resolvedBy),
        orNull(comment.editedAt),
        comment.createdAt,
        comment.anchor === undefined ? null : JSON.stringify(comment.anchor),
        orNull(comment.deletedAt),
        orNull(comment.deletedBy),
        orNull(comment.deleteReason),
      )
  }

  async find(tenantId: string, id: string): Promise<Comment | null> {
    const row = this.db
      .prepare('SELECT * FROM comments WHERE tenant_id = ? AND id = ?')
      .get(tenantId, id) as CommentRow | undefined
    return row ? toComment(row) : null
  }

  async list(tenantId: string, resourceType: string, resourceId: string): Promise<Comment[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM comments WHERE tenant_id = ? AND resource_type = ? AND resource_id = ? ORDER BY created_at',
      )
      .all(tenantId, resourceType, resourceId) as unknown as CommentRow[]
    return rows.map(toComment)
  }

  async update(tenantId: string, id: string, patch: CommentPatch): Promise<Comment | null> {
    // A key present in the patch is written (even if `undefined` → NULL, which is
    // how reopen clears resolvedAt/resolvedBy); an absent key is left untouched.
    const sets: string[] = []
    const args: Bindable[] = []
    if ('body' in patch) {
      sets.push('body = ?')
      args.push(orNull(patch.body))
    }
    if ('mentions' in patch) {
      sets.push('mentions = ?')
      args.push(JSON.stringify(patch.mentions ?? [])) // column is NOT NULL
    }
    if ('editedAt' in patch) {
      sets.push('edited_at = ?')
      args.push(orNull(patch.editedAt))
    }
    if ('resolvedAt' in patch) {
      sets.push('resolved_at = ?')
      args.push(orNull(patch.resolvedAt))
    }
    if ('resolvedBy' in patch) {
      sets.push('resolved_by = ?')
      args.push(orNull(patch.resolvedBy))
    }
    if ('deletedAt' in patch) {
      sets.push('deleted_at = ?')
      args.push(orNull(patch.deletedAt))
    }
    if ('deletedBy' in patch) {
      sets.push('deleted_by = ?')
      args.push(orNull(patch.deletedBy))
    }
    if ('deleteReason' in patch) {
      sets.push('delete_reason = ?')
      args.push(orNull(patch.deleteReason))
    }
    if (sets.length > 0) {
      args.push(tenantId, id)
      this.db.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...args)
    }
    return this.find(tenantId, id)
  }

  async delete(tenantId: string, id: string): Promise<void> {
    this.db.prepare('DELETE FROM comments WHERE tenant_id = ? AND id = ?').run(tenantId, id)
    this.db.prepare('DELETE FROM comment_revisions WHERE tenant_id = ? AND comment_id = ?').run(tenantId, id)
  }

  async addRevision(revision: CommentRevision): Promise<void> {
    this.db
      .prepare('INSERT INTO comment_revisions (tenant_id, id, comment_id, body, at, by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(revision.tenantId, revision.id, revision.commentId, revision.body, revision.at, orNull(revision.by))
  }

  async revisions(tenantId: string, commentId: string): Promise<CommentRevision[]> {
    const rows = this.db
      .prepare('SELECT * FROM comment_revisions WHERE tenant_id = ? AND comment_id = ? ORDER BY at, rowid')
      .all(tenantId, commentId) as unknown as {
      tenant_id: string
      id: string
      comment_id: string
      body: string
      at: number
      by: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      commentId: r.comment_id,
      body: r.body,
      at: r.at,
      ...(r.by !== null ? { by: r.by } : {}),
    }))
  }
}

export interface SqliteCommentsStores {
  db: DatabaseSync
  store: SqliteCommentStore
}

/**
 * Open a database (or reuse a `DatabaseSync`) and return the comment store wired
 * to it, named to drop straight into `commentsPlugin`:
 *
 * ```ts
 * const c = sqliteCommentsStore('./data/comments.db')
 * commentsPlugin({ store: c.store })
 * ```
 */
export function sqliteCommentsStore(dbOrLocation: DatabaseSync | string = ':memory:'): SqliteCommentsStores {
  const db = typeof dbOrLocation === 'string' ? openCommentsDatabase(dbOrLocation) : dbOrLocation
  if (typeof dbOrLocation !== 'string') migrate(db)
  return { db, store: new SqliteCommentStore(db) }
}
