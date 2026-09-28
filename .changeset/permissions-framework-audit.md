---
'@basaltkit/permissions': major
---

Security fixes from the framework audit (FA-002..FA-006, FA-H14).

- **Policy lookup no longer walks `Object.prototype` (FA-002).** `project:constructor` / `project:toString` used to resolve to `Object` / `Object.prototype.toString` and authorize anyone; `project:hasOwnProperty` crashed with a `TypeError`. Checks are now snapshotted into a prototype-free lookup of their own entries (in `definePolicy` and `gate.register`), a check authorizes only when it returns exactly `true`, and `can()` refuses a permission that is not a non-empty string without whitespace.
- **Only an exact `resource:action` selects a policy check (FA-003).** `project:update:billing` was decided by the `update` check; it is now a missing policy (`MissingPolicyError`, or RBAC with `onMissingPolicy: 'rbac'`).
- **A missing user id is not a user (FA-004).** `can`/`authorize`/`hasRole` with no user, or one without a non-empty string `id`, throw `AuthRequiredGuardError` (401) instead of a `TypeError` or a check against the shared `undefined`/`null` bucket; writes (`assignRole`, `grantToUser`, …, and `MemoryAccessStore`) refuse such ids with a `TypeError`; the `meta.can` guard treats `context.user = {}` as unauthenticated.
- **The Gate re-verifies what `TemporaryGrantStore` / `DelegationStore` return (FA-005)** — user, scope and a finite `expiresAt > now` on the Gate's clock — so a lax durable store cannot make temporary grants permanent. `grantTemporarily()` / `delegate()` refuse a non-finite (`Infinity`) or past `expiresAt`.
- **`grantTemporarily()` requires `ttlMs` or `expiresAt` (FA-H14).** Without either it used to write an already-expired grant silently; it now throws a `TypeError`.
- **Scope-less writes outside a tenant fail closed in multi-tenant apps (FA-006).** With tenancy active (`permissionsPlugin` reads `tenancyPlugin`'s `tenancy:active` marker; `new Gate` takes `tenancyActive`), `assignRole`/`removeRole`/`grantToRole`/`grantToUser`/`grantTemporarily`/`delegate` with no `scope` and no tenant in the context throw the new `ScopeRequiredError` (`PERMISSION_SCOPE_REQUIRED`, 400) instead of writing a platform-wide `@global` grant. Single-tenant apps and Gates with a custom `scope` option are unaffected.

**Why major:** these fixes change defaults callers may rely on. In a multi-tenant app, code that wrote global grants implicitly outside a request (seed scripts, CLI tasks, central endpoints) now throws — pass `GLOBAL_SCOPE` explicitly, or set `allowGlobalWrites: true` to restore the old fallback. `grantTemporarily()` without a deadline, three-segment permissions checked against a policy, and `can()` with a malformed user or permission now throw instead of answering.
