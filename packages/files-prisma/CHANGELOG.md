# @basaltkit/files-prisma

## 0.2.0

### Minor Changes

- b69ea05: MySQL no longer truncates long values silently (framework audit FA-070).
  
  On MySQL Prisma maps a bare `String` to `VARCHAR(191)`, and a server outside
  strict mode cuts a longer value with only a warning: a webhook URL delivered
  elsewhere, a file `path` stopped naming its object, JSON payloads stopped
  parsing, and a truncated audit payload or hash broke the hash chain for good.
  
  - Each package ships **`schema.mysql.prisma`** (exported as
    `@basaltkit/<pkg>/schema.mysql.prisma`): the same models with the free-text
    columns widened (`@db.Text`, `@db.MediumText`, `@db.VarChar(255)`) and the
    keys left at `VARCHAR(191)`. `comments-prisma`'s variant stores `mentions` as
    `Json` (MySQL has no scalar lists); the store now reads either form.
  - Every factory and store class takes an optional **`columnLimits`**
    (`'mysql'` — the preset matching that schema, exported as
    `<domain>MysqlColumnLimits` — or your own per-model limits, in characters or
    `{ bytes }`). With it set, a value longer than its column is refused with
    `ColumnLengthError` (`COLUMN_LENGTH_EXCEEDED`, 422) before anything is
    written. The outbox's diagnostic `lastError` is shortened (marked
    `…[truncated]`) instead, so `markFailed` still counts the attempt.
  - `basalt prisma:sync` (`@basaltkit/prisma`) copies the MySQL variant when the
    app's `datasource` provider is `mysql`, and warns about a package without one.
  
  Unset, nothing changes: PostgreSQL and SQLite are unaffected, and existing
  calls keep their signatures (the option is a new trailing parameter).

### Patch Changes

- e53db52: Framework audit, pass 2 — persistent stores (FA-068, FA-069, FA-070).
  
  Major for tenancy-prisma, webhooks-prisma, webhooks-sqlite and auth-prisma: a generated PrismaClient still fits the new client interfaces (`$transaction`, `create`/`updateMany`), but hand-written clients and test fakes must add those methods, and cross-scope writes that used to succeed now throw.
  
  - **tenancy-prisma — `save()` / `create()` are atomic (FA-068).** The tenant
    row, the domain check and the domain set (`deleteMany` + `createMany`) now
    run in one interactive `$transaction`. Before, any failure after the delete —
    a domain listed twice, a domain another tenant claimed between the
    pre-flight and the insert, a lost connection — left the tenant rewritten with
    its existing domains gone. Duplicate domains in the array are stored once.
    `PrismaTenancyClient` now includes `$transaction` (a generated
    `PrismaClient` has it; a hand-written client must add it).
  - **webhooks-prisma — writes are keyed by `(id, tenantId)` (FA-069).**
    `add()` was an upsert by `id` alone: on MySQL's case-insensitive collation
    tenant A re-registering `ABC` rewrote tenant B's `abc` endpoint (url,
    secret, tenant). It is now an `updateMany` scoped to the endpoint's own
    tenant (or global scope), falling back to `create`; an id held by another
    scope throws the new `WebhookEndpointIdInUseError` (409). Re-adding an id in
    its own scope still replaces it. `PrismaWebhooksClient` now needs
    `create`/`updateMany` instead of `upsert` (a generated `PrismaClient` has
    them).
  - **webhooks-sqlite — no `INSERT OR REPLACE` across scopes (FA-070/D8).** The
    manager's check-before-write cannot stop two tenants registering the same id
    at once; the store now refuses an id held by another scope with
    `WebhookEndpointIdInUseError` (409) instead of overwriting that endpoint.
  - **auth-prisma — `touch()`/`revoke()` of a missing API key are no-ops
    (FA-070/I4)**, as in the other stores, instead of a Prisma `P2025` thrown
    out of `verify()`. The client surface uses `authApiKey.updateMany` (no longer
    `update`).
  - **auth-sqlite — email uniqueness without the NOCASE index (FA-070/D9).** A
    legacy database holding case-variant duplicates cannot build the
    case-insensitive unique index, and `migrate()` skipped it silently; `create`
    now refuses an email that exists in any letter case inside the `INSERT`
    itself, throwing `EmailTakenError` (409) — also for the race between two
    concurrent sign-ups.
  - **files-prisma — `prismaFilesStore()` fails fast** when the client has no
    `file` model, like every other `*-prisma` factory (FA-070/I4).
  - **permissions-sqlite — multi-permission grants are all-or-nothing**
    (FA-070/I5): `grantToRole` / `grantToUser` run in one savepoint.
- Updated dependencies [e54b7b1]
  - @basaltkit/files@5.0.0

## 0.1.1

### Patch Changes

- Updated dependencies [fb85c40]
  - @basaltkit/files@4.0.0

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
