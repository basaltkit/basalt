<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/files-prisma

**Prisma-backed** implementation of the
[`@basaltkit/files`](https://github.com/basaltkit/basalt/tree/main/packages/files)
`FileStore` — the record of every uploaded file — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `File` model; the store only
touches that delegate.

```bash
pnpm add @basaltkit/files-prisma   # peer: @basaltkit/files ; you already have @prisma/client
```

## Why you want this before you go to production

`@basaltkit/files` defaults to `MemoryFileStore`. For a cache or a queue an
in-memory default is a fair trade — it loses work that can be redone. Here it
loses something else.

The bytes go to your storage disk under a key like `files/6f2c…`, and that key
lives only in the file record. Lose the record and the bytes stay in the bucket
forever: unreferenced, unlistable, unbillable to any tenant, and impossible to
match back to the document they were. Meanwhile the application reports an empty
file list and nothing errors anywhere.

That is what a restart did before this package existed.

## 1. Add the model

Run **`basalt prisma:sync`** (from
[`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma)),
which discovers every installed `@basaltkit/*-prisma` package and merges its
models into your schema:

```bash
pnpm basalt prisma:sync --push
```

Or copy the model from the bundled reference schema
(`@basaltkit/files-prisma/schema.prisma`):

```prisma
model File {
  tenantId    String
  id          String
  name        String
  contentType String
  size        BigInt
  path        String
  checksum    String
  uploadedBy  String?
  metadata    Json?
  scannedAt   DateTime?
  createdAt   DateTime

  @@id([tenantId, id])
  @@index([tenantId, createdAt])
  @@index([tenantId])
  @@map("files")
}
```

Then `prisma migrate dev`.

**`size` is a `BigInt`** because `Int` stops at 2 GB, which a video upload passes
without trying. It reaches your code as a `number` — `Number.MAX_SAFE_INTEGER` is
about 8 petabytes, so nothing is lost on the way out.

**`scannedAt` is a date, not a flag.** It replaced `scanned: boolean` in the
contract: the date derives the boolean, the boolean does not derive the date, and
"scanned" with no idea when stops being an answer the moment the scanner's rules
change — which is the one thing antivirus rules reliably do.

## 2. Wire it up

```ts
import { filesPlugin } from '@basaltkit/files'
import { prismaFilesStore } from '@basaltkit/files-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const files = prismaFilesStore(prisma)

filesPlugin({ disk, store: files.store })
```

Schema-per-tenant applications pass the tenant's client instead — see
[`tenantClient()`](https://github.com/basaltkit/basalt/tree/main/packages/prisma).

## API reference

### `prismaFilesStore(client): { store }`

Returns the store named to drop straight into `filesPlugin`.

### `PrismaFileStore`

Implements the six methods of `FileStore`. Two are worth knowing about:

| Method | Note |
| --- | --- |
| `totalSize(tenantId)` | Summed by the database, not by listing rows and adding up in JS. A quota check runs on every upload; a tenant with fifty thousand files should not move fifty thousand rows to learn one number. |
| `update(tenantId, id, patch)` | A key **present** in the patch is written even when its value is `undefined` — that is how a caller clears a stale scan result. A key that is absent is left untouched. |

Every method is scoped by `tenantId` and none of them can be asked for a row
without one: the primary key is `[tenantId, id]`, so a lookup with the right id
and the wrong tenant returns nothing rather than someone else's file.

### `PrismaFilesClient`

The minimal delegate surface the store calls. A real `PrismaClient` with the
`File` model is assignable, so pass it directly.
