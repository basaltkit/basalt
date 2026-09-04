# @basaltkit/files-versions

## 0.1.1

### Patch Changes

- 6c9f1c7: `files-versions` reads the ambient tenant, like `Files` always did.
  
  `FileVersions` resolved its store key as `tenantId ?? SINGLE_TENANT_SCOPE`,
  skipping the request context. `Files.upload` does read the context, so the two
  disagreed: a multi-tenant application that passed no explicit `tenantId` — the
  normal case — wrote versions under `acme` and read them back under `'default'`.
  `history()` returned `[]` and `latest()` returned `null` for a document that
  existed, and `download()` raised `FileVersionNotFoundError` for a file sitting
  on the disk.
  
  A silent wrong answer, which is worse than the error it replaced, and precisely
  the failure this package was written to prevent. Its own README described the
  correct behaviour, not the implemented one.
  
  The rule now lives in one place. `@basaltkit/files` exports `fileScope()` and
  `resolveFileTenant()`, `Files` uses them internally, and `FileVersions` takes
  the same `tenancyActive` probe — wired by `fileVersionsPlugin` from the same
  `'tenancy:active'` marker `filesPlugin` reads. Two implementations of one rule
  is one too many.
  
  Single-tenant applications are unaffected: with no tenancy registered there is
  no tenant to resolve and the scope stays `SINGLE_TENANT_SCOPE`. That path is now
  exercised by the `beyond-saas` tripwire, which covered `files` but not
  `files-versions` — which is why this shipped.
  
  ---
  
  **`@basaltkit/activity` adopts the safe scope when tenancy is present.**
  
  `tenantScoped` defaulted to `true`, meaning "scope to the context tenant, and
  run **unscoped** when there is none". In a multi-tenant application a feed query
  made outside a tenant context therefore answered with every tenant's records —
  and an activity line is not an aggregate number, it reads "Dr. Kiala opened
  matter 2026/014 for Kwanza Lda": another firm's client, by name, in prose.
  
  `activityPlugin` now tightens to `'required'` when `@basaltkit/tenancy` is
  registered and the application expressed no preference — the same thing
  `@basaltkit/cache` already does, and what the framework's own rule asks for: a
  generic package never requires tenancy, but adopts safe defaults when it is
  there. A single-tenant app is untouched, and `tenantScoped: false` still wins
  for an operator console that means to read across tenants.

## 0.1.0

### Minor Changes

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
  - @basaltkit/files@3.0.0
