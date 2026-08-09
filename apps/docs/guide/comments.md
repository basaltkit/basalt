# Comments

`@basaltkit/comments` adds threaded comments to **any resource** — a note, a
project, a task — with @mentions and resolve/reopen, scoped per tenant. It emits
events that bridge cleanly to [realtime](/guide/realtime) (live discussion) and
notifications (alert the mentioned).

## Setup

```ts
import { commentsPlugin, COMMENTS, commentRoutes } from '@basaltkit/comments'

commentsPlugin()
// routes: [...commentRoutes()]  →  create/list/edit/delete/resolve/reopen
```

## Add and read

```ts
const comments = app.container.get(COMMENTS)

const root = await comments.on('note', 'note-1').add({ authorId: 'u1', body: 'Nice work @u2!' })
await comments.on('note', 'note-1').add({ authorId: 'u2', body: 'Thanks!', parentId: root.id })

const tree = await comments.on('note', 'note-1').tree() // nested replies
```

`add` extracts @mentions from the body (configurable pattern), stores them on
the comment, and emits `comment:created` plus one `comment:mentioned` per
mentioned user. Also: `edit`, `remove`, `resolve(id, by)`, `reopen(id)`.

## Live discussion + mention notifications

The events do the wiring, with no coupling:

```ts
// push new comments to everyone viewing the resource
hooks.on('comment:created', ({ comment }) =>
  realtime.to(comment.tenantId).channel(`${comment.resourceType}:${comment.resourceId}`).emit('comment', comment))

// notify the mentioned
hooks.on('comment:mentioned', ({ comment, userId }) =>
  notifications.to(userId).send('comment.mention', { by: comment.authorId }))
```

## Routes

`commentRoutes()` (require a logged-in user; author taken from `ctx().user`):
`GET /comments?resourceType=&resourceId=`, `POST /comments`,
`PATCH /comments/:id`, `DELETE /comments/:id`,
`POST /comments/:id/resolve` and `/reopen`. Editing and deleting are restricted
to the comment's author. Everything is tenant-scoped.

Ready-made UI is not needed here — comments render inline in your app — but the
same self-contained pattern powers the [audit viewer](/reference/packages).
