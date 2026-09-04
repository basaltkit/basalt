---
'@basaltkit/files-prisma': minor
'@basaltkit/files': major
'@basaltkit/prisma': minor
---

`@basaltkit/files-prisma`: the file domain finally has a durable store.

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
