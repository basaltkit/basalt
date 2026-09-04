# @basaltkit/permissions

## 1.3.1

### Patch Changes

- 36ab1a1: Add `gate.actor()`, a browser-safe `/match` subpath, and `accessRoutes()`.
  
  **`gate.actor()`** returns the current user with its roles attached. What
  `@basaltkit/auth` puts in the context is `PublicUser` — `{ id, email,
  emailVerified }` — with no roles, rightly, since `auth` does not know this
  package exists. But policies receive that object, so `user.roles?.includes(…)`
  read `undefined` and the policy denied: the right failure mode and an invisible
  one, a partner treated as a stranger in their own firm with no error anywhere.
  
  Nothing filled the gap, so every service hydrated by hand and memoised under a
  private context key it had to invent. This memoises per request *and per scope* —
  the same person can hold different roles in two tenants — and returns `null`
  when there is no user, rather than an actor that fails every check for a reason
  nobody can read.
  
  **`@basaltkit/permissions/match`** exports `permissionMatches` and `permitted`
  and imports nothing. The rule was already implemented and unreachable from a
  browser: the package has a single entry point and depends on `@basaltkit/core`,
  which imports `node:async_hooks`. So frontends rewrote it, and the rewrites
  drifted — one handled `resource:*` and missed the global `'*'`, hiding controls
  from the people allowed to use them.
  
  **`accessRoutes()`** serves `GET /me/access` with `{ roles, permissions }`,
  merging direct grants with everything each role carries. `/auth/me` answers who
  you are; nothing answered what you may do, so every frontend wrote the same
  twenty lines. Not a security surface — the server still decides on every
  request — but a UI that stops offering doors returning 403.
  
  It deliberately has no `meta.auth`: a public page asks before anyone logs in,
  and empty is the honest answer there.
- 36ab1a1: Give route `meta` a shape, and refuse to boot on a plan that is not in the
  catalogue.
  
  **`meta.subscribed` is now checked at boot.** The toolkit already refused to
  boot a route declaring `meta.subscribed` without `subscriptionsPlugin` — it
  checked the *plugin* existed, never that the *value* meant anything.
  `Subscriptions.subscribed()` compares strings and returns false when they do not
  match, and the guard turns that into a 402. So a route gated on a plan absent
  from the catalogue was indistinguishable from one nobody subscribed to: it
  answered 402 to every paying customer, forever, with nothing in the logs.
  
  `subscriptionsPlugin` now validates every `meta.subscribed` against the plans it
  was given and throws `UnknownPlanMetaError`, naming all offending routes at once
  and listing what the catalogue does have. The check runs on `app:booted`, not in
  the plugin's own boot: adapters publish `http:routes` during *their* boot phase,
  so reading the list earlier would depend on plugin order and silently pass.
  
  **`meta` is typed.** It was `Record<string, unknown>`, so `can: 123` compiled.
  `RouteMeta` is exported from `@basaltkit/http` and augmented by each guard
  plugin — `can` by permissions, `subscribed`/`feature` by subscriptions, `auth`
  by auth — the same pattern `BasaltHooks` uses.
  
  It stays open. The index signature keeps every existing route compiling and lets
  applications add their own keys, which means a **misspelt** key still compiles:
  `subcribed: 'pro'` is not a type error. That gap is closed at boot instead, by
  the two checks above. The typing catches wrong value types and lets an editor
  complete the names.
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.3.0

### Minor Changes

- 104cfb3: `can(user, permission, resource)` no longer degrades silently from ABAC to RBAC when the policy is missing.
  
  **Advisory — this tightens a default.** `can()` looked up `resource:action` in the registered policies and, when nothing matched, *fell through to the permission strings*. A typo in either half — `doc:updat`, or `docs:update` for a policy registered as `doc` — meant the ownership check the author wrote never ran, and a broad grant like `doc:*` allowed the request. The gate answered `true` for a document owned by someone else.
  
  Passing a resource is an explicit statement of ABAC intent, so an unmatched policy now throws `MissingPolicyError` (`PERMISSION_POLICY_MISSING`, 500). The message names the permission, lists the registered policies, and points at the three fixes: register the check with `definePolicy()`, correct the `resource:action` spelling, or drop the resource argument if plain RBAC was what you meant.
  
  Nothing else moves: `can()` **without** a resource is untouched pure RBAC, a registered policy still decides on its own, and `superAdmin` still short-circuits first. The route guard never passes a resource, so no shipped route changes behaviour. To restore the historic fall-through — for apps that pass resources opportunistically — set `onMissingPolicy: 'rbac'` on the gate.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.2.0

### Minor Changes

- a76d591: **Security: `meta.can` now supports `string[]` (all-of) and fails CLOSED on unenforceable shapes.**
  
  The guard used to silently skip the permission check for any non-string `meta.can` — `can: ['billing:manage']` or `can: true` type-checked (route meta is `Record<string, unknown>`) and the route served with **no authorization at all**, only the auth check. Now:
  
  - `can: 'projects:delete'` — unchanged.
  - `can: ['reports:read', 'reports:export']` — NEW: requires **all** listed permissions (the natural reading; the sibling API-key guard already uses an array for `meta.scopes`).
  - Anything else (`true`, a number, an empty or mixed array) throws the new `InvalidCanMetaError` (`PERMISSION_META_INVALID`, HTTP 500) on every request to that route — an unenforceable authorization declaration must fail loud, never fail open.
  
  The plugin also claims `'can'` in the new `http:guarded-meta` bucket, so the adapters' boot check can reject routes that declare `meta.can` when `permissionsPlugin` is not registered (see the `@basaltkit/http` release).
  
  **Behavior change:** a route that previously declared a malformed `meta.can` was silently unprotected; it now errors. That is the fix.

### Patch Changes

- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.1.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.1.0

### Minor Changes

- 978c5be: Add temporary permissions and delegation. `gate.grantTemporarily(userId,
permissions, { ttlMs | expiresAt })` gives time-boxed access (break-glass,
  short tasks) via a `TemporaryGrantStore`. `gate.delegate({ from, to, permissions,
expiresAt? })` lets one user act with a subset of another's authority via a
  `DelegationStore` — bounded at check time to the delegator's _direct_ permissions
  (never lends more than the delegator has) and non-chaining (a delegatee can't
  re-delegate authority it only holds by delegation). In-memory stores included;
  both are opt-in via `GateOptions`.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/fastify@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/fastify@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/fastify@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/fastify@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/fastify@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/fastify@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/fastify@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/fastify@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/fastify@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/fastify@0.4.0
  - @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @basaltkit/fastify@0.3.0
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
  - @basaltkit/fastify@0.1.0
