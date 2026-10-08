---
"@basaltkit/comments": minor
---

BK-080:

- Fix: the default mention pattern no longer reads the domain of an email
  address as a mention (`ana@example.com` mentioned `example`). It is now
  `DEFAULT_MENTION_PATTERN` — `@id` not preceded by a word character, `.`, `+`
  or `-`. `DELIMITED_MENTION_PATTERN` (`@{id}`) is exported for ids with dots or `@`.
- Every hook payload carries `actorId` when an actor is known: the author
  (`created`, `mentioned`), the resolver (`resolved`), the explicit actor
  (`edit(id, body, { actorId })`, `remove(id, { by })`, `reopen(id, { actorId })`)
  or `ctx().user.id`. The positional `tenantId` argument still works.
- `AddCommentInput.anchor` / `Comment.anchor`: a JSON object (≤ 4 KB, else
  `400 COMMENT_ANCHOR_INVALID`) saying where in the resource the comment points;
  `POST /comments` accepts it.
- Opt-in `deletion: 'soft'` (default stays `'hard'`): `remove()` sets
  `deletedAt`/`deletedBy`/`deleteReason` and `list()`/`tree()` return a
  tombstone; `comment:deleted` carries `soft: true`.
- Opt-in `editWindowMs`: `edit()` past it throws `CommentEditWindowClosedError` (409).
- Opt-in `revisions: true`: `edit()` records the previous body through the new
  optional `CommentStore.addRevision`/`revisions`; `Comments.revisions(id)` lists
  them. A store without them fails at boot (`CommentRevisionsUnsupportedError`).
