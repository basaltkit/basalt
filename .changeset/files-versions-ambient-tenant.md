---
'@basaltkit/files-versions': patch
'@basaltkit/files': minor
'@basaltkit/activity': minor
---

`files-versions` reads the ambient tenant, like `Files` always did.

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
