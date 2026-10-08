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
`add` extracts mentions with `DEFAULT_MENTION_PATTERN` — `@id` (`[\w-]+`) not
preceded by a word character, `.`, `+` or `-`, so `ana@example.com` is **not** a
mention of `example`. Pass `mentionPattern` (a `g` regex whose first capture
group is the user id) to `commentsPlugin` to match your own id scheme;
`DELIMITED_MENTION_PATTERN` reads `@{any-id}` for ids with dots or `@`.
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
mentioned user. Also: `edit`, `remove`, `resolve(id, by)`, `reopen(id)` — and,
opt-in, [anchors, soft delete, an edit window and revisions](#anchors-soft-delete-edit-window-and-revisions).

::: warning Bounded bodies and mentions
A body longer than `maxBodyLength` (default **10 000** characters) throws
`CommentTooLongError` (`400 COMMENT_TOO_LONG`), and one carrying more than
`maxMentions` distinct mentions (default **50**) throws
`CommentMentionLimitError` (`400 COMMENT_TOO_MANY_MENTIONS`) — on `add` and on
`edit`, before anything is stored or emitted. Every `@id` is otherwise taken at
face value, so when `comment:mentioned` reaches a real notification channel,
pass `resolveMentions(ids, tenantId)` to keep only users who may be mentioned —
typically the tenant's members:

```ts
commentsPlugin({
  resolveMentions: async (ids, tenantId) => (await members.of(tenantId, ids)).map((m) => m.userId),
})
```
:::

Inside a tenant context an explicit `tenantId` argument must name that tenant;
any other value throws `CommentTenantMismatchError` (`403
COMMENT_TENANT_MISMATCH`). It selects a tenant only outside one (jobs, CLI).

In a **single-tenant** app — no `tenancyPlugin` — calls need no `tenantId`, and
comments are filed under one internal store key, `SINGLE_TENANT_SCOPE`
(`'@single'` — outside the tenant-id grammar, so no tenant can ever be handed
those comments). A tenant id equal to it is refused with
`CommentTenantReservedError` (`400 COMMENT_TENANT_RESERVED`).

::: warning Upgrading single-tenant data
Before `@basaltkit/comments` 4.0 the single-tenant key was `'default'` — a valid
tenant id, so a tenant named `default` read, edited and deleted the
single-tenant comments. A single-tenant app with persisted comments re-keys them
once: `UPDATE comments SET "tenantId" = '@single' WHERE "tenantId" = 'default'`
(`@basaltkit/comments-prisma`; the `@basaltkit/comments-sqlite` column is
`tenant_id`). Skip it if `default` was ever a real tenant in that database.
:::

## Live discussion + mention notifications

Every mutation emits a hook (`comment:created`, `comment:mentioned`,
`comment:updated`, `comment:deleted`, `comment:resolved`, `comment:reopened`),
so live updates and notifications wire up with no coupling. Each payload
carries `actorId` — who did it: the author for `created`/`mentioned`, the
resolver for `resolved`, otherwise the explicit actor (`edit(id, body, {
actorId })`, `remove(id, { by })`) or `ctx().user.id`; it is absent only when a
call runs outside a request with no actor given. Subscribe on `app.hooks`:

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

The hooks are in-process. To put comment activity on the durable
[`@basaltkit/events`](/guide/queues) bus (outbox, queued listeners), bridge the
ones you need:

```ts
import { EVENTS, defineEvent } from '@basaltkit/events'

const CommentCreated = defineEvent<{ commentId: string; actorId?: string }>('comment.created')
app.hooks.on('comment:created', ({ comment, actorId }) =>
  app.container.get(EVENTS).emit(CommentCreated, { commentId: comment.id, ...(actorId ? { actorId } : {}) }))
```

## Anchors, soft delete, edit window and revisions

All opt-in; without them comments behave exactly as before.

```ts
commentsPlugin({
  deletion: 'soft',          // remove() keeps a tombstone instead of deleting the row
  editWindowMs: 15 * 60_000, // edit() refused with 409 after 15 minutes
  revisions: true,           // edit() keeps every previous body
})

// anchor: where in the resource the comment points (JSON object, ≤ 4 KB)
await comments.on('contract', 'c-12').add({ authorId: 'u1', body: 'Check this clause', anchor: { page: 3, rect: [72, 540, 300, 560] } })

await comments.remove(id, { by: 'moderator-1', reason: 'off-topic' })
await comments.revisions(id) // [{ body, at, by }, …] oldest first
```

| Option | Default | Behaviour |
| --- | --- | --- |
| `deletion` | `'hard'` | `'soft'` sets `deletedAt`/`deletedBy`/`deleteReason`; `list()`/`tree()` return the comment as a **tombstone** (empty `body`, no `mentions`) so replies keep their place. `get()` still returns the stored record (moderation). A soft-deleted comment answers 404 to edit/resolve/reopen; removing it again is a no-op. `comment:deleted` carries `soft: true` |
| `editWindowMs` | none | `edit()` past the window throws `CommentEditWindowClosedError` (`409 COMMENT_EDIT_WINDOW_CLOSED`) |
| `revisions` | `false` | `edit()` records the previous body (`CommentRevision`) before replacing it. Needs a store with `addRevision`/`revisions` (memory, SQLite, Prisma); otherwise the app **fails at boot** with `CommentRevisionsUnsupportedError` |

`anchor` must be a plain JSON object of at most 4 KB (`400
COMMENT_ANCHOR_INVALID`); `POST /comments` accepts it in the body. The Prisma
schema gained optional `anchor`, `deletedAt`, `deletedBy`, `deleteReason`
columns and a `CommentRevision` model — they are only written when you use the
feature, so add them before turning it on. SQLite migrates itself.

### Rejecting unknown mentions

`resolveMentions` filters silently. To **refuse** a comment that mentions
someone who cannot be mentioned, throw from it — the error propagates out of
`add`/`edit` (and through the routes, with its own status) before anything is
stored:

```ts
commentsPlugin({
  resolveMentions: async (ids, tenantId) => {
    const known = new Set((await members.of(tenantId, ids)).map((m) => m.userId))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length) throw new HttpError(422, 'UNKNOWN_MENTION', `Unknown users: ${unknown.join(', ')}`)
    return ids
  },
})
```

## Routes

`commentRoutes()` (require a logged-in user; author taken from `ctx().user`):
`GET /comments?resourceType=&resourceId=`, `POST /comments`,
`PATCH /comments/:id`, `DELETE /comments/:id`,
`POST /comments/:id/resolve` and `/reopen`. By default any user of the tenant
may read a thread and post to it, and editing, deleting, resolving and reopening
are restricted to the comment's author (`403 COMMENT_FORBIDDEN`). Everything is
tenant-scoped.

Pass `authorize` to tie a thread to the access rules of the resource it
discusses. It replaces the default policy; compose with `defaultCommentPolicy`
to keep it:

```ts
import { commentRoutes, defaultCommentPolicy } from '@basaltkit/comments'

commentRoutes({
  // action: 'list' | 'create' | 'edit' | 'delete' | 'resolve' | 'reopen'
  // target: { resourceType, resourceId, comment? }
  authorize: async (action, target, user) =>
    (await canSeeMatter(user.id, target.resourceId)) &&
    (defaultCommentPolicy(action, target, user) || (action === 'resolve' && user.role === 'admin')),
})
```

To answer **404** instead of 403 for a resource the caller may not even know
exists, throw `CommentNotFoundError` from `authorize` — the error's status
reaches the client on every adapter:

```ts
import { CommentNotFoundError, commentRoutes } from '@basaltkit/comments'

commentRoutes({
  authorize: async (action, target, user) => {
    if (!(await canSeeMatter(user.id, target.resourceId))) throw new CommentNotFoundError() // 404 COMMENT_NOT_FOUND
    return defaultCommentPolicy(action, target, user)
  },
  meta: { can: 'comments:write' }, // extra route meta, merged into every route (auth: true always kept)
})
```

Ready-made UI is not needed here — comments render inline in your app — but the
same self-contained pattern powers the [audit viewer](/reference/packages).
