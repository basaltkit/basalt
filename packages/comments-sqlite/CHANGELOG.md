# @machize/comments-sqlite

## 0.29.0

### Minor Changes

- Initial release. Durable, SQLite-backed implementation of the @machize/comments `CommentStore`, on Node's built-in `node:sqlite`, with zero external dependencies. `sqliteCommentsStore(location)` returns the store named to drop straight into `commentsPlugin`. The single-node counterpart to `@machize/comments-prisma`.
