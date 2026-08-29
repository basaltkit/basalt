---
"@basaltkit/cache": minor
---

**Advisory — in multi-tenant apps, cache operations with no resolvable tenant scope now fail CLOSED by default.**

`onMissingScope` defaulted to `'global'`: a `remember()`/`put()` outside request context (a background job, a boot task) silently read and wrote one namespace **shared across all tenants** — a tenant-A value could be served to tenant B. Now, when `@basaltkit/tenancy` is registered (detected via its `tenancy:active` metadata marker), `cachePlugin` defaults `onMissingScope` to `'error'`: such operations throw `MissingCacheScopeError` instead of silently widening.

- **Single-tenant apps (no tenancy plugin) are untouched** — the global namespace keeps working.
- An explicit `onMissingScope: 'global'` opts back in deliberately, and a custom `scope` function is left alone (its author owns the semantics).
- `flush()` already always failed closed; reads/writes now match it.

**If a background job starts throwing after upgrading:** wrap it in `runWithContext({ tenant })` for the tenant it serves, or pass `onMissingScope: 'global'` if cross-tenant sharing is genuinely intended.
