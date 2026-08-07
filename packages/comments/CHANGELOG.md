# @machize/comments

## 0.17.0

### Patch Changes

- @machize/core@0.17.0
- @machize/fastify@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0
- @machize/fastify@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/fastify@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/fastify@0.14.0

## 0.13.0

### Minor Changes

- bbefc0c: New package: `@machize/comments` — per-resource comment threads.

  Attach comments to any resource (`resourceType`:`resourceId`) within a tenant, with nested replies (`tree()`), @mention extraction, and resolve/reopen. `comments.on(type, id).add({ authorId, body, parentId? })` mints a comment, pulls @mentions from the body (configurable pattern), and emits `comment:created` plus one `comment:mentioned` per mentioned user — so `@machize/realtime` can push live and `@machize/notifications` can alert the mentioned, with no coupling. Also `edit`/`remove`/`resolve`/`reopen`, each emitting its event. `commentRoutes()` exposes list/create/edit/delete/resolve/reopen with the author taken from `ctx().user` and edits/deletes restricted to the author. `CommentStore` (with `MemoryCommentStore`) persists threads; tenant comes from the argument or the request context. Fully unit-tested, including the HTTP author-permission flow.

### Patch Changes

- @machize/core@0.13.0
- @machize/fastify@0.13.0
