---
'@basaltkit/files-versions': minor
'@basaltkit/files-prisma': minor
---

`@basaltkit/files-versions`: documents have revisions.

Debuts at **0.1.0**: new, and not yet under the 1.0 stability promise the rest
of the ecosystem carries.

`Files.upload` mints a new id and a new path on every call, so uploading the
same contract twice produced two unrelated records with nothing linking them —
no way to ask what a document looked like in March, and no way to know which of
the two is current. Every application that needed that wrote the same
bookkeeping by hand: read the highest version, upload, move a pointer.

```ts
const { groupId } = await versions.create(pdf, { name, contentType, note: 'primeira minuta' })
await versions.addVersion(groupId, revisto, { name, contentType, note: 'após reunião' })

await versions.history(groupId)     // newest first
await versions.download(groupId, 1) // the draft the client was sent in January
```

**Not a `version` field on `FileRecord`.** A file record describes bytes; a
revision describes an editorial act. A version column would make every consumer
of files carry a concept most of them do not have, and still would not link the
two uploads. Each revision points at a whole file, and earlier revisions keep
their own bytes — nothing is overwritten.

**The store assigns the version number, and it is scoped by tenant.** A caller
that reads the latest and adds one has a race; two uploads landing together
would both claim the same revision. `@basaltkit/files-prisma/versions` keys the
table on `[tenantId, groupId, version]`, so the database refuses the duplicate:
one upload wins, the other fails loudly. For a contract draft, a failed upload
beats a history that cannot say which draft is which.

Tenant scoping is the first argument of every store method rather than an
afterthought: `history(groupId)` alone reads one firm's document history from
another firm's session the moment a group id reaches a URL, which is exactly
where group ids end up.

`@basaltkit/files-prisma` gains the durable store behind a `./versions` subpath,
with `@basaltkit/files-versions` as an optional peer — the main entry never
reaches for it.
