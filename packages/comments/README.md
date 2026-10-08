<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/comments

Per-resource comments for Basalt: **threads** (nested replies), **@mentions**, and **resolve/reopen**, isolated by tenant, emitting **events** that connect to [`@basaltkit/realtime`](https://www.npmjs.com/package/@basaltkit/realtime) (live discussion) and [`@basaltkit/notifications`](https://www.npmjs.com/package/@basaltkit/notifications) (notify who was mentioned). You need this module when you want collaboration — commenting on a note, a project, a task.

## What this module solves

A comment system involves more than storing text: threads with replies, extracting @mentions to notify, marking a discussion as resolved, and restricting edits to the author. This module gives you all of that — attached to **any resource** (`resourceType`:`resourceId`) and isolated by tenant — and emits events for the rest of the ecosystem to react to.

## Installation

```bash
pnpm add @basaltkit/comments
```

Depends on `@basaltkit/core` and `@basaltkit/fastify` (routes). No database required: the default store is in-memory (`CommentStore` contract for production).

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { commentsPlugin, COMMENTS, commentRoutes } from '@basaltkit/comments'
import { fastifyPlugin } from '@basaltkit/fastify'

const app = await createApp({
  plugins: [commentsPlugin(), fastifyPlugin({ routes: [...commentRoutes()] })],
}).boot()

const comments = app.container.get(COMMENTS)

// add a comment to a resource
const root = await comments.on('note', 'note-1', 'acme').add({ authorId: 'u1', body: 'Great work @u2!' })

// reply (thread)
await comments.on('note', 'note-1', 'acme').add({ authorId: 'u2', body: 'Thanks!', parentId: root.id })

// get the comment tree
const tree = await comments.on('note', 'note-1', 'acme').tree()
```

`add` extracts @mentions from the body (default `@id`), stores them on the comment, and emits `comment:mentioned` for each mentioned user.

## Connecting to realtime and notifications

The power is in the events. Push comments live and notify mentioned users without coupling anything:

```ts
import { defineNotification, NOTIFIER } from '@basaltkit/notifications'
import { z } from 'zod'

// live discussion (realtime)
hooks.on('comment:created', ({ comment }) =>
  realtime.to(comment.tenantId).channel(`${comment.resourceType}:${comment.resourceId}`).emit('comment', comment))

// notify whoever was mentioned
const CommentMention = defineNotification({
  name: 'comment.mention',
  schema: z.object({ by: z.string(), resource: z.string() }),
  channels: ['inApp'],
  via: { inApp: ({ by, resource }) => ({ title: 'You were mentioned', body: `${by} mentioned you`, data: { resource } }) },
})
const notifier = app.container.get(NOTIFIER)

hooks.on('comment:mentioned', async ({ comment, userId }) => {
  // the recipient is any `Notifiable` ({ id, email? }) — load the user if a channel needs more than the id
  await notifier.notify({ id: userId }, CommentMention, { by: comment.authorId, resource: comment.resourceId })
})
```

## Routes

`commentRoutes()` (all require login; author comes from `ctx().user`):

| Route | Description |
|---|---|
| `GET /comments?resourceType=&resourceId=` | Comment tree for the resource. |
| `POST /comments` `{ resourceType, resourceId, body, parentId?, anchor? }` | Create (or reply). `parentId` must be a comment of the same resource, otherwise 400 `COMMENT_PARENT_NOT_FOUND`. `anchor` is a JSON object (≤ 4 KB). |
| `PATCH /comments/:id` `{ body }` | Edit — **author only**. |
| `DELETE /comments/:id` | Delete — **author only**. |
| `POST /comments/:id/resolve` · `/reopen` | Resolve / reopen the discussion — **author only**. |

Pass `commentRoutes({ authorize: (action, { resourceType, resourceId, comment? }, user) => boolean })` to apply your own per-resource policy (it replaces the default; compose with `defaultCommentPolicy`). Throw `CommentNotFoundError` from it to answer 404 instead of 403. `commentRoutes({ meta })` merges extra route meta (e.g. `{ can: 'comments:write' }`) into every route; `auth: true` is always kept.

## API reference

### `commentsPlugin({ store?, mentionPattern?, maxBodyLength?, maxMentions?, resolveMentions?, deletion?, editWindowMs?, revisions? })`

Registers the `COMMENTS` token. `mentionPattern` is a `g` regex whose first group is the mentioned id (default `DEFAULT_MENTION_PATTERN`: `@id` not preceded by a word character, `.`, `+` or `-`, so an email's domain is not a mention; `DELIMITED_MENTION_PATTERN` reads `@{id}`). Bodies are capped at `maxBodyLength` characters (default 10 000) and `maxMentions` distinct mentions (default 50); `resolveMentions(ids, tenantId)` keeps only the ids that may be mentioned (e.g. tenant members) — throw from it to reject the comment instead.

Opt-in: `deletion: 'soft'` keeps removed comments as tombstones (`deletedAt`/`deletedBy`/`deleteReason`; `list()`/`tree()` blank the body and mentions); `editWindowMs` refuses edits after the window (`CommentEditWindowClosedError`, 409); `revisions: true` records each previous body (needs a store with `addRevision`/`revisions`, otherwise boot fails with `CommentRevisionsUnsupportedError`).

### `class Comments`

| Method | Description |
|---|---|
| `on(resourceType, resourceId, tenantId?)` | `{ add, list, tree }` for a resource. |
| `get(id, tenantId?)` | A single comment. |
| `edit(id, body, tenantId? \| { tenantId?, actorId? })` | Edits and re-extracts mentions; emits `comment:updated`. 404 on a soft-deleted comment, 409 past `editWindowMs`. |
| `remove(id, tenantId? \| { tenantId?, actorId?, by?, reason? })` | Deletes (or soft-deletes); emits `comment:deleted` (`soft: true` for a tombstone). |
| `resolve(id, by, tenantId?)` · `reopen(id, tenantId? \| { tenantId?, actorId? })` | Emits `comment:resolved` / `comment:reopened`. |
| `revisions(id, tenantId?)` | Previous bodies, oldest first (`revisions: true`). |

Without `tenantId`, uses `ctx().tenant.id` (otherwise `CommentTenantRequiredError`). Inside a tenant context an explicit `tenantId` must equal it (`CommentTenantMismatchError`, 403). An app without `@basaltkit/tenancy` has no tenant dimension: its comments are keyed by `SINGLE_TENANT_SCOPE` (`'@single'`, a sentinel outside the tenant-id grammar; a tenant carrying it is refused with `CommentTenantReservedError`, `COMMENT_TENANT_RESERVED`, 400).

> **Upgrading from 3.x (single-tenant data):** the key used to be `'default'`, a valid tenant id — a tenant named `default` could read, edit and delete the single-tenant comments. Re-key persisted rows once: `UPDATE comments SET "tenantId" = '@single' WHERE "tenantId" = 'default'` (`@basaltkit/comments-prisma`; with `@basaltkit/comments-sqlite` the column is `tenant_id`). Skip it if `default` was ever a real tenant in that database.

### Events

`comment:created` · `comment:updated` · `comment:deleted` · `comment:resolved` · `comment:reopened` · `comment:mentioned` (one per mentioned user). Every payload carries `actorId` when an actor is known (the author, the resolver, the explicit actor, or `ctx().user.id`).

## How it connects to other modules

- **`@basaltkit/realtime`** — pushes `comment:created` to the resource's channel (live discussion).
- **`@basaltkit/notifications`** — reacts to `comment:mentioned` to notify mentioned users.
- **`@basaltkit/auth` / `@basaltkit/tenancy`** — provide the user (author) and tenant from context.
