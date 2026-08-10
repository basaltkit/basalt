# Comments

`@basaltkit/comments` adds threaded comments to **any resource** — a note, a
project, a task — with @mentions and resolve/reopen, scoped per tenant. It emits
events that bridge cleanly to [realtime](/guide/realtime) (live discussion) and
notifications (alert the mentioned).

[[toc]]

## Setup

Register `commentsPlugin` and mount the ready-made REST routes through your
adapter. In dev the store is in-memory; in production pass a `store` backed by
`@basaltkit/comments-prisma` or `-sqlite`:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { COMMENTS, commentsPlugin, commentRoutes } from '@basaltkit/comments'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [...commentRoutes()] }), // create/list/edit/delete/resolve/reopen
    commentsPlugin(),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

::: tip Custom @mention pattern
`add` extracts mentions with `@([\w-]+)` by default. Pass `mentionPattern` (a
regex whose first capture group is the user id) to `commentsPlugin` to match
your own id scheme.
:::

## Add and read

```ts
import { COMMENTS } from '@basaltkit/comments'
const comments = app.container.get(COMMENTS)

const root = await comments.on('note', 'note-1').add({ authorId: 'u1', body: 'Nice work @u2!' })
await comments.on('note', 'note-1').add({ authorId: 'u2', body: 'Thanks!', parentId: root.id })

const tree = await comments.on('note', 'note-1').tree() // nested replies
```

`add` extracts @mentions from the body (configurable pattern), stores them on
the comment, and emits `comment:created` plus one `comment:mentioned` per
mentioned user. Also: `edit`, `remove`, `resolve(id, by)`, `reopen(id)`.

## Live discussion + mention notifications

Every mutation emits a hook (`comment:created`, `comment:mentioned`,
`comment:updated`, `comment:deleted`, `comment:resolved`, `comment:reopened`),
so live updates and notifications wire up with no coupling. Subscribe on
`app.hooks`:

```ts
import { REALTIME } from '@basaltkit/realtime'
import { NOTIFIER, defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'
import { app } from './app.js'

const realtime = app.container.get(REALTIME)
const notifier = app.container.get(NOTIFIER)

const CommentMention = defineNotification({
  name: 'comment.mention',
  schema: z.object({ by: z.string() }),
  channels: ['inApp'],
  via: { inApp: ({ by }) => ({ title: 'You were mentioned', data: { by } }) },
})

// push new comments to everyone viewing the resource
app.hooks.on('comment:created', ({ comment }) =>
  realtime
    .to(comment.tenantId)
    .channel(`${comment.resourceType}:${comment.resourceId}`)
    .emit('comment', comment))

// notify the mentioned — one hook fires per mentioned user
app.hooks.on('comment:mentioned', ({ comment, userId }) =>
  notifier.notify({ id: userId }, CommentMention, { by: comment.authorId }))
```

## Routes

`commentRoutes()` (require a logged-in user; author taken from `ctx().user`):
`GET /comments?resourceType=&resourceId=`, `POST /comments`,
`PATCH /comments/:id`, `DELETE /comments/:id`,
`POST /comments/:id/resolve` and `/reopen`. Editing and deleting are restricted
to the comment's author. Everything is tenant-scoped.

Ready-made UI is not needed here — comments render inline in your app — but the
same self-contained pattern powers the [audit viewer](/reference/packages).
