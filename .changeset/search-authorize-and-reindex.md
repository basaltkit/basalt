---
'@basaltkit/search': minor
---

Row-level authorization, and rebuilding an index from the rules that feed it.

**`authorize`** — search was the one surface with no answer for per-row
visibility. A driver filters by the fields declared `filterable` and nothing
else, so in a product where a confidential matter is visible only to the people
assigned to it, search was the single place the package left unsolved. Both ways
around it were bad:

- **Copy the ACL into the index.** Fast, and it makes the index a second copy of
  an access rule. Removing someone from a confidential matter changes the
  database and not the index, and search keeps showing it to them until somebody
  reindexes. A stale index gives an old result; a stale ACL gives an
  unauthorized one.
- **Over-fetch and trim.** Correct, but the over-fetch factor is a guess and a
  caller with little access gets short pages.

```ts
search.search('matters', q, { limit: 20, authorize: (hits) => filterByPolicy(hits) })
```

The hook runs after the driver, which is what lets the package keep asking until
the page is full — the thing a caller cannot do from outside. `offset` counts
authorized hits, so page two continues where page one ended. `maxScan` bounds
the work, and `totalExact` says whether `total` is the whole truth: a driver's
total counts rows the caller may not see, and rendering it would put "42
results" above three rows.

Callers with no hook are unchanged: one driver call, same behaviour, same cost.

**`backfill` and `search.reindex(index)`** — an index fed by events knows only
what was created after the rule existed. An application adding search to data it
already has gets a box that returns nothing for everything old, and an empty
result is indistinguishable from "there is none".

```ts
syncRule({
  hook: 'matter:opened',
  index: 'matters',
  document: ({ matter }) => ({ id: matter.id, tenantId: matter.tenantId, number: matter.number }),
  backfill: async function* () { /* pages of the same payload */ },
})

await search.reindex('matters')
```

`backfill` yields **hook payloads**, not rows, so one `document` function serves
both directions. A second mapping written by hand is the drift this prevents:
let it disagree and the same search returns different things depending on
whether a record predates the last rebuild. The index is cleared first — a
rebuild that appends leaves documents for records that no longer exist — and an
index with no `backfill` raises rather than reporting a rebuild that did
nothing.
