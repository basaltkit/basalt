# @basaltkit/files-prisma

## 0.1.0

### Minor Changes

- 30abb78: `@basaltkit/files-prisma`: the file domain finally has a durable store.
  
  Debuts at **0.1.0**, not 1.0.0. The eleven sibling `-prisma` packages are at 1.x
  and covered by the ecosystem's semver commitment; this one has not been run
  against a real database by anyone yet, and saying so in the version number is
  cheaper than saying it in a changelog nobody reads.
  
  Of the framework's domains, eleven ship both `-prisma` and `-sqlite` backends
  without a single exception. `files` shipped neither. It was the only domain with
  a store contract and no durable implementation of it, and its default was
  `MemoryFileStore`.
  
  For a cache or a queue, an in-memory default is a fair trade — it loses work
  that can be redone. Here it loses something else. The bytes go to the disk under
  a key like `files/6f2c…`, and that key lives only in the file record. Lose the
  record and the bytes stay in the bucket forever: unreferenced, unlistable,
  unmatchable to the document they were. The application reports an empty file
  list, and nothing errors anywhere.
  
  ```ts
  import { prismaFilesStore } from '@basaltkit/files-prisma'
  
  filesPlugin({ disk, store: prismaFilesStore(prisma).store })
  ```
  
  `totalSize` sums in the database rather than listing rows and adding up in JS: a
  quota check runs on every upload, and a tenant with fifty thousand files should
  not move fifty thousand rows to learn one number.
  
  **Two changes to the `@basaltkit/files` contract**, both breaking:
  
  - **`scanned?: boolean` is now `scannedAt?: number`.** The date derives the
    boolean and the boolean does not derive the date, and "scanned" with no idea
    when stops being an answer the moment the scanner's rules change — which is
    the one thing antivirus rules reliably do. `markScanned()` stamps it; the
    `file:scanned` hook keeps its name, because the event is not the field.
  - **`metadata` is now `FileMetadata`** — a `Record<string, JsonValue>` rather
    than `Record<string, unknown>`. Every durable store would otherwise have had
    to cast its way past its driver's own JSON type, a cast each implementation
    repeats and has to get right. Saying what the column actually holds costs
    nothing at the call site: an object literal of strings, numbers and nested
    objects already satisfies it.
  
  `@basaltkit/prisma` adds `files` to the domains `prisma:sync` discovers, so the
  model is merged into your schema like every other one.
- 30abb78: `@basaltkit/files-versions`: documents have revisions.
  
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

### Patch Changes

- Updated dependencies [30abb78]
- Updated dependencies [30abb78]
  - @basaltkit/files@3.0.0
  - @basaltkit/files-versions@0.1.0
