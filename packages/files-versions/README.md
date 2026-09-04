<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/files-versions

Document **revisions** on top of
[`@basaltkit/files`](https://github.com/basaltkit/basalt/tree/main/packages/files).
Each revision points at its own file, so an earlier draft keeps its own bytes and
nothing is ever overwritten.

```bash
pnpm add @basaltkit/files-versions   # peers: @basaltkit/files, @basaltkit/core
```

## The problem

`Files.upload` mints a new id and a new path on every call. Upload the same
contract twice and you have two unrelated records with nothing linking them —
no way to ask "what did this document look like in March?", and no way to know
which of the two is current.

So every application that needed revisions wrote the same bookkeeping by hand:
read the highest version, upload, move a `currentVersionId` pointer. That is
this package.

## Why not a `version` field on `FileRecord`

A file record describes bytes: their size, their checksum, where they sit on the
disk. A revision describes an editorial act — someone replaced the draft, and
said why.

Putting a version column on the byte record makes every consumer of files carry
a concept most of them do not have, and still does not link the two uploads.
Keeping them apart means the file layer stays about files.

## Use

```ts
import { filesPlugin } from '@basaltkit/files'
import { fileVersionsPlugin, FILE_VERSIONS } from '@basaltkit/files-versions'

createApp({ plugins: [filesPlugin({ disk }), fileVersionsPlugin()] })
```

```ts
const versions = container.get(FILE_VERSIONS)

// First revision. Keep the group id against your own entity — a matter's
// contract, a client's mandate. It never changes again.
const { groupId } = await versions.create(pdf, {
  name: 'contrato.pdf',
  contentType: 'application/pdf',
  uploadedBy: user.id,
  note: 'primeira minuta',
})

// A later draft. The previous one is untouched.
await versions.addVersion(groupId, revisto, {
  name: 'contrato.pdf',
  contentType: 'application/pdf',
  uploadedBy: user.id,
  note: 'após reunião com o cliente',
})

await versions.history(groupId)          // newest first
await versions.download(groupId)         // the current draft
await versions.download(groupId, 1)      // the one the client was sent in January
```

## A durable store

The default is memory, which is right for a test and wrong for anything else: a
restart takes the history with it and leaves the files behind, so every past
draft is still on the disk with nothing left to say which document it belonged
to. The bytes keep costing money and answer no questions.

```ts
import { prismaFileVersionsStore } from '@basaltkit/files-prisma/versions'

fileVersionsPlugin({ store: prismaFileVersionsStore(prisma).store })
```

The model ships in
[`@basaltkit/files-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/files-prisma)'s
reference schema; `basalt prisma:sync` merges it like any other.

## API reference

### `FileVersions`

| Method | Returns |
| --- | --- |
| `create(content, input)` | The first revision plus the new `groupId` |
| `addVersion(groupId, content, input)` | The new revision and its file |
| `latest(groupId, tenantId?)` | The current revision with its file, or `null` |
| `at(groupId, n, tenantId?)` | One revision by number, or `null` |
| `history(groupId, tenantId?)` | Every revision, newest first — versions only, no file lookups |
| `download(groupId, n?, tenantId?)` | The bytes of one revision; defaults to the current |

`input` is the `UploadInput` of `@basaltkit/files` plus an optional `note`.
`tenantId` is optional and last, and resolves exactly as in `Files`: the
explicit argument, then `ctx().tenant`, then the single-tenant scope. Passing
nothing inside a tenant context is the normal case and works.

Reading a revision whose file has been deleted throws
`FileVersionNotFoundError` rather than handing back a row that cannot be
downloaded.

### `FileVersionStore`

`append`, `latest`, `history`, `at` — all scoped by tenant, **first argument**.

That is not decoration. The obvious signature, `history(groupId)`, reads one
firm's document history from another firm's session the moment a group id
reaches a URL — and a group id is exactly the kind of value that reaches a URL.

**The store assigns the version number**, never the caller. A caller that reads
the latest and adds one has a race, and two uploads landing together would both
claim the same revision. The Prisma store's primary key is
`[tenantId, groupId, version]`, so the database refuses the duplicate: one
upload wins and the other fails loudly. For a contract draft, a failed upload is
better than a history that cannot say which draft is which.
