# @basaltkit/comments-sqlite

Durable, **SQLite-backed** implementation of the
[`@basaltkit/comments`](https://github.com/Zebedeu/basalt/tree/main/packages/comments)
`CommentStore` — per-resource threads with @mentions and resolve/reopen — built
on Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero
external dependencies.**

Swap it in for the in-memory store and comment threads survive a restart — no
ORM, no migration tool, no service. The single-node reference backend; the
production (Postgres/MySQL) counterpart is
[`@basaltkit/comments-prisma`](https://github.com/Zebedeu/basalt/tree/main/packages/comments-prisma).

```bash
pnpm add @basaltkit/comments-sqlite   # peer: @basaltkit/comments
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

```ts
import { commentsPlugin } from '@basaltkit/comments'
import { sqliteCommentsStore } from '@basaltkit/comments-sqlite'

const c = sqliteCommentsStore('./data/comments.db')   // ':memory:' by default

const app = await createApp({
  plugins: [commentsPlugin({ store: c.store })],
}).boot()
```

`SqliteCommentStore` is also exported and takes a `DatabaseSync`, so it can share
a handle with the other `*-sqlite` stores. `openCommentsDatabase()` and
`migrate()` are exported too.

## Notes

- One `comments` table, keyed by `(tenant_id, id)` and indexed by resource;
  threads list oldest-first, exactly as in the in-memory store.
- **Resolve/reopen** is faithful: a patch key present with `undefined` clears the
  column (reopen), an absent key is left untouched.
- `mentions` are stored as JSON and round-trip unchanged.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contract.

## License

MIT
