---
"@basaltkit/comments-prisma": minor
"@basaltkit/comments-sqlite": minor
---

BK-080: the comment stores persist `anchor` and the soft-delete fields
(`deletedAt`, `deletedBy`, `deleteReason`) and implement the optional revision
methods (`addRevision`, `revisions`); a hard delete also drops the comment's
revisions.

Prisma: the reference schemas gain optional `anchor`, `deletedAt`, `deletedBy`
and `deleteReason` columns on `Comment` and a `CommentRevision` model. They are
written only when the matching feature is used, so an existing schema keeps
working until you pass an `anchor`, turn on `deletion: 'soft'` or
`revisions: true`. SQLite: `migrate()` adds the columns and the
`comment_revisions` table to databases created by older versions.
