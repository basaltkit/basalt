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
// live discussion (realtime)
hooks.on('comment:created', ({ comment }) =>
  realtime.to(comment.tenantId).channel(`${comment.resourceType}:${comment.resourceId}`).emit('comment', comment))

// notify whoever was mentioned
hooks.on('comment:mentioned', ({ comment, userId }) =>
  notifications.to(userId).send('comment.mention', { by: comment.authorId, resource: comment.resourceId }))
```

## Routes

`commentRoutes()` (all require login; author comes from `ctx().user`):

| Route | Description |
|---|---|
| `GET /comments?resourceType=&resourceId=` | Comment tree for the resource. |
| `POST /comments` `{ resourceType, resourceId, body, parentId? }` | Create (or reply). |
| `PATCH /comments/:id` `{ body }` | Edit — **author only**. |
| `DELETE /comments/:id` | Delete — **author only**. |
| `POST /comments/:id/resolve` · `/reopen` | Resolve / reopen the discussion. |

## API reference

### `commentsPlugin({ store?, mentionPattern? })`

Registers the `COMMENTS` token. `mentionPattern` is a regex whose first group is the mentioned id (default `@([\w-]+)`).

### `class Comments`

| Method | Description |
|---|---|
| `on(resourceType, resourceId, tenantId?)` | `{ add, list, tree }` for a resource. |
| `get(id, tenantId?)` | A single comment. |
| `edit(id, body, tenantId?)` | Edits and re-extracts mentions; emits `comment:updated`. |
| `remove(id, tenantId?)` | Deletes; emits `comment:deleted`. |
| `resolve(id, by, tenantId?)` · `reopen(id, tenantId?)` | Emits `comment:resolved` / `comment:reopened`. |

Without `tenantId`, uses `ctx().tenant.id` (otherwise `CommentTenantRequiredError`).

### Events

`comment:created` · `comment:updated` · `comment:deleted` · `comment:resolved` · `comment:reopened` · `comment:mentioned` (one per mentioned user).

## How it connects to other modules

- **`@basaltkit/realtime`** — pushes `comment:created` to the resource's channel (live discussion).
- **`@basaltkit/notifications`** — reacts to `comment:mentioned` to notify mentioned users.
- **`@basaltkit/auth` / `@basaltkit/tenancy`** — provide the user (author) and tenant from context.
