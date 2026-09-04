---
'@basaltkit/search-postgres': patch
---

Cast the language parameter to `regconfig` in `to_tsvector` and `plainto_tsquery`.

`PgClientLike` accepts any client with a `query()` method, and clients disagree
on parameter typing. `pg` sends parameters untyped and lets Postgres infer `$5`
as `regconfig`; Prisma sends them as `text`, and `to_tsvector(text, text)` does
not exist — every index and search failed with error 42883.

That made this driver unusable with the client `@basaltkit/prisma` recommends:
two official packages of the same toolkit that did not fit together. Apps hit it
as a hard failure on the first indexed document, and worked around it by
rewriting the driver's SQL with a regular expression before executing it.

The cast is redundant under `pg` and required under Prisma, so it belongs here
rather than in every application. No API change; parameter numbering and query
shape are unchanged.
