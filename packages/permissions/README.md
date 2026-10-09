<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/permissions

Authorization for Basalt applications: roles, wildcard permissions, resource-based policies, super admin, and route protection — in the style of Laravel's Spatie Permissions.

You need this module when different users can do different things in your application (e.g. only admins can delete projects).

## What this module solves

Authentication (knowing *who* the user is) isn't enough: you also need **authorization** — deciding *what* that user can do. Scattering `if (user.isAdmin)` throughout the code quickly becomes unmanageable. This module centralizes those decisions in one place, the **Gate**, which you ask: "can this user do `projects:delete`?".

The building blocks are: **permissions** (labels like `projects:delete`, with wildcard support — `projects:*` covers all project actions and `*` covers everything), **roles** (named sets of permissions, like `admin`, assigned to users), and **policies** (contextual rules about a specific resource, e.g. "only the project owner can edit it").

Everything is **scoped per tenant** by default: a permission granted within the "acme" tenant doesn't apply in the "globex" tenant. Grants in the `global` scope apply everywhere. Assignments live in an `AccessStore` — in memory for development, in your database in production.

## Installation

```bash
pnpm add @basaltkit/permissions
```

## Get started in 5 minutes

1. **Create a store and grant permissions:**

```ts
import { Gate, MemoryAccessStore, GLOBAL_SCOPE } from '@basaltkit/permissions'

const store = new MemoryAccessStore()

// The "admin" role can do everything on projects and read billing (global scope)
await store.grantToRole('admin', ['projects:*', 'billing:read'], GLOBAL_SCOPE)

// Ada is an admin
await store.assignRole('user-ada', 'admin', GLOBAL_SCOPE)
```

2. **Create the Gate and ask it:**

```ts
const gate = new Gate({ store })

await gate.can({ id: 'user-ada' }, 'projects:delete') // true (via projects:*)
await gate.can({ id: 'user-ada' }, 'billing:write')   // false
await gate.hasRole({ id: 'user-ada' }, 'admin')       // true
```

3. **Or require the permission (throws a 403 error if missing):**

```ts
await gate.authorize({ id: 'user-ada' }, 'projects:delete') // ok
await gate.authorize({ id: 'other-user' }, 'projects:delete') // throws PermissionDeniedError
```

4. **In an HTTP application, protect routes with `meta.can`:**

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { permissionsPlugin, MemoryAccessStore, GLOBAL_SCOPE } from '@basaltkit/permissions'

const store = new MemoryAccessStore()
await store.grantToUser('user-ada', ['projects:delete'], GLOBAL_SCOPE)

const app = await createApp({
  plugins: [
    // ... an authentication plugin that sets ctx().user (e.g. @basaltkit/auth)
    permissionsPlugin({ store }),
    fastifyPlugin({
      routes: [
        route({
          method: 'DELETE',
          url: '/projects/:id',
          meta: { can: 'projects:delete' }, // without the permission → 403
          async handler() { return { deleted: true } },
        }),
      ],
    }),
  ],
}).boot()
```

Without an authenticated user, the route returns 401 (`AUTH_REQUIRED`); with a user lacking the permission, it returns 403 (`PERMISSION_DENIED`).

## Usage guide

### Wildcard permissions

A permission is a string; by convention `resource:action`. Matching is done with `permissionMatches(granted, requested)`:

- `projects:delete` covers exactly `projects:delete`;
- `projects:*` covers `projects:delete`, `projects:read`, … (but **not** `projects:sub:deep` — the number of segments must match);
- `*` covers everything.
- a permission with an empty segment (`''`, `projects:`, `:read`, `a::b`) matches nothing — not even itself, and no wildcard covers it. The Gate refuses one with a `TypeError` in `can()`, grants and `roleCatalog`; `hasEmptySegment(permission)` checks it.

### Roles

A role groups permissions and is assigned to users within a scope:

```ts
import { MemoryAccessStore } from '@basaltkit/permissions'

const store = new MemoryAccessStore()
await store.grantToRole('editor', ['articles:read', 'articles:write'], 'acme')
await store.assignRole('user-bob', 'editor', 'acme') // only applies in the acme tenant
await store.removeRole('user-bob', 'editor', 'acme')
```

You can also grant permissions directly to a user with `grantToUser(userId, permissions, scope)`.

### Per-tenant scope

When the Gate checks, it looks for grants in **two** scopes: the current scope and `GLOBAL_SCOPE` (`'@global'`). The current scope, by default, is `ctx().tenant.id` set by `@basaltkit/tenancy` — or `GLOBAL_SCOPE` if there's no tenant. You can override it with the `scope` option:

```ts
import { Gate, MemoryAccessStore } from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  scope: () => 'my-scope', // advanced: custom scope
})
```

### A role catalogue for per-tenant roles

A role's permissions are normally looked up **in the scope where the role is held**. `@basaltkit/teams` assigns roles per tenant (`assignRole(user, 'owner', tenantId)`), so a catalogue granted once in `GLOBAL_SCOPE` never reaches a tenant owner. Two ways to define the catalogue once:

```ts
permissionsPlugin({
  store,
  // (a) Code-defined, valid in every scope: a role held in tenant A grants these
  //     permissions in tenant A — never in tenant B, never globally.
  roleCatalog: {
    owner: ['*'],
    admin: ['projects:*', 'members:invite'],
    member: ['projects:read'],
  },
  // (b) Or keep the catalogue in the store under GLOBAL_SCOPE and let tenant-held
  //     roles resolve their permissions from it (still granting only in the tenant).
  inheritGlobalRolePermissions: ['admin', 'member'], // or `true` for every role name
})
```

Both are unions with what the store grants the role in the tenant itself, use the same wildcard rule, and grant **permissions, not roles** — `hasRole()`, `effectiveRoles()` and audience confinement are unchanged. Prefer a list for `inheritGlobalRolePermissions` when tenant admins can assign role names themselves: with `true`, assigning a globally defined `platform-admin` inside a tenant grants its global permission set in that tenant.

### Policies (rules about a specific resource)

A **policy** decides by looking at the object in question — for example, "only the owner can edit." When you call `can()` with a third argument (the resource) and a policy exists for `resource:action`, the policy decides (grants are not consulted):

```ts
import { Gate, MemoryAccessStore, definePolicy } from '@basaltkit/permissions'

interface Project { ownerId: string }

const ProjectPolicy = definePolicy<Project>('project', {
  update: (user, project) => project.ownerId === user.id,
})

const gate = new Gate({ store: new MemoryAccessStore(), policies: [ProjectPolicy as never] })
// or later: gate.register(ProjectPolicy as never)

await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'u9' })    // true
await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'other-user' }) // false
```

**Passing a resource fails closed.** If no policy is registered for that resource — or the policy has no check for that action — `can()` throws `MissingPolicyError` (`PERMISSION_POLICY_MISSING`) instead of answering from the granted permission strings. It used to fall through silently, which meant a typo (`project:updat`, or `projects:update` for a policy registered as `project`) skipped the ownership rule entirely and a broad `project:*` grant allowed the request. The error names the permission and lists the registered policies.

Fix it by registering the check, correcting the `resource:action` spelling, or dropping the resource argument if plain RBAC is what you meant. `onMissingPolicy: 'rbac'` restores the historic fall-through. `can()` **without** a resource is untouched pure RBAC.

**Enforce it on the route.** Declare the resource in `meta.can` and the guard loads it and lets the policy decide — no Gate call in the handler to forget. See [Resource-aware `meta.can`](#resource-requirements-policies-in-the-guard).

**The match is exact.** Only the policy's *own* actions count (`project:constructor` / `project:toString` are missing policies, never `Object.prototype`), only a two-segment `resource:action` selects a check (`project:update:billing` is not decided by `update`), and a check authorizes only when it returns `true`. `can()` refuses a permission that is not a non-empty string without whitespace (`TypeError`); a user without a non-empty string `id` makes `can`/`authorize`/`hasRole` throw `AuthRequiredGuardError` (401).

**Policies decide one object, not a list.** Filtering a query's rows through `gate.can()` afterwards gives short pages and a wrong `total`. For listings, declare the list form of the check next to it and apply it in the query, reusing the same `where` for `findMany` and `count`:

```ts
const DocumentPolicy = definePolicy<Document, Prisma.DocumentWhereInput>(
  'document',
  { read: (user, doc) => doc.ownerId === user.id },
  { filters: { read: (user) => ({ ownerId: user.id }) } }, // true = unrestricted, false = none
)

const f = await gate.listFilter<Prisma.DocumentWhereInput>(me, 'document:read')
if (f.kind === 'none') return { rows: [], total: 0 }
const where = f.kind === 'unrestricted' ? filter : { AND: [f.where, filter] }
```

`listFilter` fails closed: no filter for exactly `resource:action` throws `MissingPolicyFilterError` (`PERMISSION_FILTER_MISSING`), with no RBAC fallback; `superAdmin` answers `unrestricted`, as in `can()`. `unrestricted` never bypasses tenant isolation — the tenant is your data layer's. See [Policies decide one object, not a list](https://basaltkit.dev/guide/authorization#policies-decide-one-object-not-a-list).

### Super admin

A function that, when it returns `true` for a user, authorizes everything (equivalent to Laravel's `Gate::before`):

```ts
import { Gate, MemoryAccessStore } from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  superAdmin: (user) => user['owner'] === true,
})

await gate.can({ id: 'x', owner: true }, 'any:thing') // true, always
await gate.hasRole({ id: 'x', owner: true }, 'editor') // false — a bypass, not a role
await gate.isSuperAdmin({ id: 'x', owner: true })     // true
```

The bypass is **authority, not membership**: it short-circuits `can()`,
`authorize()` and `meta.can`, but `hasRole()` answers only the roles the user
actually holds (until 4.0 it answered `true` for every role name). Where you used
`hasRole()` as a permission check, check the permission with `can()` — or ask for
the bypass explicitly with `isSuperAdmin()`.

### Temporary grants & delegation

Beyond standing roles and permissions, the Gate supports **time-boxed** access and
**delegation** — opt in by passing the stores:

```ts
import {
  Gate, MemoryAccessStore, MemoryTemporaryGrantStore, MemoryDelegationStore,
} from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  temporaryGrants: new MemoryTemporaryGrantStore(),
  delegations: new MemoryDelegationStore(),
})

// Break-glass / short task: extra permissions that expire on their own.
await gate.grantTemporarily('alice', ['reports:read'], { ttlMs: 60 * 60_000 }) // 1h
await gate.can({ id: 'alice' }, 'reports:read') // true until it expires

// Delegation: let Bob act with a subset of Alice's authority while she's away.
await gate.delegate({ from: 'alice', to: 'bob', permissions: ['projects:*'] })
await gate.can({ id: 'bob' }, 'projects:update') // true — *if* Alice can do it
```

Delegation is **bounded** and **non-chaining**: at check time it's limited to what
the delegator can *directly* do (their standing grants + active temporary grants,
but not their own delegations). So a delegation never lends more than the
delegator has, and a delegatee can't re-delegate authority it only holds by
delegation. Both grant and delegation carry an expiry; back the stores with your
database in production (the `Memory*` ones are per-process) — the durable ones
ship with `@basaltkit/permissions-prisma` and `@basaltkit/permissions-sqlite`:

```ts
const p = prismaAccessStore(prisma) // or sqliteAccessStore('./data/permissions.db')
permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
```

A temporary grant **needs a deadline**: `grantTemporarily()` throws without
`ttlMs` or `expiresAt`, and refuses one that is not a finite time in the future
(`Infinity` included). The Gate also re-checks whatever the stores return — user,
scope and expiry against its own clock — so a durable store that forgets its
`expires_at > ?` filter cannot make a temporary grant permanent.

### What may I do?

`accessRoutes()` adds **`GET /me/access`**: the caller's roles and permissions, so a
frontend hides the controls that would return 403 — and shows the ones that
open. Register it next to your routes (no `meta.auth`: an anonymous caller gets
an empty answer, not a 401):

```ts
fastifyPlugin({ routes: [...accessRoutes(), ...myRoutes] })
```

The answer is `gate.describeAccess(user)` and covers **every source a check
honours** — grants in the current tenant *and* the global scope, live temporary
grants, live delegations (already narrowed to what the delegator holds) and the
`superAdmin` bypass:

```json
{
  "roles": ["editor"],
  "permissions": ["billing:read", "docs:*", "reports:export"],
  "superAdmin": false,
  "grants": [
    { "permission": "docs:*", "source": "role", "scope": "acme", "role": "editor" },
    { "permission": "billing:read", "source": "direct", "scope": "@global" },
    { "permission": "reports:export", "source": "temporary", "scope": "acme", "id": "…", "expiresAt": 1767225600000 }
  ]
}
```

| Field | Meaning |
|---|---|
| `roles` | Roles held in the current scope or globally — what `hasRole()` answers `true` for. |
| `permissions` | Every permission that opens a door, sorted and deduplicated. `permitted(permissions, p)` from `@basaltkit/permissions/match` agrees with `gate.can(user, p)`. A super admin gets `['*', …]`. |
| `superAdmin` | `true` when the bypass applies. |
| `grants` | Each permission with its `source` — `'direct'`, `'role'` (+ `role`), `'temporary'` (+ `id`, `expiresAt`), `'delegation'` (+ `id`, `fromUserId`, `expiresAt?` — the earlier of the delegation's deadline and that of the delegator's temporary grant it rests on) or `'super-admin'` — and the `scope` it lives in. Refetch before the earliest `expiresAt`. |

Not a security surface: the server still decides every request. Pass
`accessRoutes({ store })` to answer from a store other than the Gate's — then
only standing grants (current + global scope) are reported. `path` renames the
route.

### Using the Gate inside handlers

For a policy on the route's own resource prefer
[resource-aware `meta.can`](#resource-requirements-policies-in-the-guard): the check then lives on
the route, where it cannot be skipped by a handler that forgets it. The Gate is
still there for everything else — a check on a *second* resource, a decision
that depends on the body the handler computes, background jobs.

The plugin registers the Gate in the container under the `GATE` token:

```ts
import { ctx, type Container } from '@basaltkit/core'
import { GATE } from '@basaltkit/permissions'

const gate = (ctx().container as Container).get(GATE)
await gate.authorize(ctx().user!, 'billing:write')
```

## API reference

### `Gate` / `permissionsPlugin(options)`

Options (`GateOptions` = `PermissionsPluginOptions`):

| Option | Type | Default | Purpose |
|---|---|---|---|
| `store` | `AccessStore` | — (required) | Where role assignments and grants live. Swap `MemoryAccessStore` for `permissions-sqlite`/`permissions-prisma` in production. |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | — | Short-circuits every check when it returns `true` (Laravel's `Gate::before`). Runs before policies, grants and delegations — keep it cheap and narrow. |
| `scope` | `() => string` | `ctx().tenant.id`, falling back to `GLOBAL_SCOPE` | The scope a check runs in. Override to key grants by something other than the tenant (a workspace, a project). |
| `policies` | `Policy<never>[]` | `[]` | Policies registered at construction; `gate.register(policy)` adds more later. |
| `temporaryGrants` | `TemporaryGrantStore` | — | Enables `grantTemporarily()`. Without it that method throws a plain `Error`, and temporary grants are never consulted. |
| `delegations` | `DelegationStore` | — | Enables `delegate()`. Without it that method throws a plain `Error`, and delegations are never consulted. |
| `now` | `() => number` | `Date.now` | Injectable clock — expiry of temporary grants and delegations is evaluated against it. |
| `onMissingPolicy` | `'error' \| 'rbac'` | `'error'` | What `can(user, perm, resource)` does when no policy check matches `resource:action`. `'error'` throws `MissingPolicyError` (fail closed); `'rbac'` falls back to the granted permission strings. Also decides whether a resource-aware `meta.can` without a policy refuses the boot (`'error'`) or answers from RBAC (`'rbac'`). |
| `resourceNotFound` | `'not-found' \| 'deny'` | `'not-found'` | Plugin only. What a resource-aware `meta.can` answers when its loader finds nothing: 404 `RESOURCE_NOT_FOUND`, or an audited 403 `PERMISSION_DENIED` (no existence oracle). A requirement's `notFound` overrides it. |
| `roleCatalog` | `Record<string, string[]>` | — | Code-defined role → permissions, valid in every scope: a role held in a scope grants its catalogue permissions in that scope only. Union with the store's role grants. Snapshotted at construction; malformed entries throw `TypeError`. See [A role catalogue for per-tenant roles](#a-role-catalogue-for-per-tenant-roles). |
| `inheritGlobalRolePermissions` | `boolean \| string[]` | `false` | A tenant-held role also resolves its permissions from its `GLOBAL_SCOPE` definition (and the legacy one with `readLegacyGlobalScope`), granting only in that tenant. A list limits it to those role names. |
| `allowGlobalWrites` | `boolean` | `false` | Let a scope-less write outside a tenant fall back to `GLOBAL_SCOPE` even when tenancy is active. See [Writes need a tenant or an explicit scope](#writes-need-a-tenant-or-an-explicit-scope). |
| `tenancyActive` | `() => boolean` | plugin: the `tenancy:active` marker; `new Gate`: `false` | Whether the app is multi-tenant; decides whether scope-less writes outside a tenant fail closed. |
| `readLegacyGlobalScope` | `boolean` | `false` | Also treat rows stored under the pre-1.5 global scope `'global'` as global. Transition aid only — see [The global scope is `'@global'`](#the-global-scope-is-global). |
| `hooks` | `HookBus` | the app's bus (plugin) | Where `permission:*` hooks are emitted. `permissionsPlugin` wires it for you. |

#### The global scope is `'@global'`

`GLOBAL_SCOPE` used to be the string `'global'`. Grants are keyed by tenant id,
so a tenant *named* `global` — say, a workspace a user picked at sign-up — wrote
its members' roles (teams mirrors memberships into the store) into the
platform-wide bucket, and its owner held those grants in every tenant.
`GLOBAL_SCOPE` is now `'@global'`, a value no slug, hostname label or uuid can
take, and the Gate throws `ReservedScopeError` (`PERMISSION_SCOPE_RESERVED`,
403) instead of evaluating a request whose tenant id is `'@global'` or
`'global'`. Refuse both in your tenant registry too (`isReservedScope(id)`).
A request carrying a tenant with no non-empty string id gets the same error
rather than falling back to the global scope.

**Upgrading:** grants you stored with the literal `'global'` are no longer read
as global. Migrate them:

```sql
UPDATE perm_user_roles       SET scope = '@global' WHERE scope = 'global';
UPDATE perm_user_permissions SET scope = '@global' WHERE scope = 'global';
UPDATE perm_role_permissions SET scope = '@global' WHERE scope = 'global';
```

(Prisma: the `PermUserRole` / `PermUserPermission` / `PermRolePermission`
models.) Until you can, `readLegacyGlobalScope: true` keeps reading them — but
while it is on, a tenant with id `'global'` can write global grants again, so
reserve that id first.

#### Writes need a tenant or an explicit scope

`assignRole`, `removeRole`, `grantToRole`, `grantToUser`, `grantTemporarily` and
`delegate` default to the current scope. When tenancy is active (`tenancyPlugin`
registered — `permissionsPlugin` reads its `tenancy:active` marker; a hand-built
Gate takes `tenancyActive`) and **no tenant is in the context**, a scope-less
write throws `ScopeRequiredError` (`PERMISSION_SCOPE_REQUIRED`, 400) instead of
landing in `GLOBAL_SCOPE`. Pass the scope — `GLOBAL_SCOPE` when a platform-wide
grant is really meant — or set `allowGlobalWrites: true`. Single-tenant apps are
unaffected, and so is a Gate with a custom `scope` option.

#### Scope resolution and `TENANT_REQUIRED`

The default scope reads `ctx().tenant?.id` and **falls back to
`GLOBAL_SCOPE`** when there is no tenant. That is deliberate: a permission check
outside a tenant (a CLI command, a central route) still has a well-defined
answer, and every check consults the current scope *and* `global`.

The consequence: this package never throws `TENANT_REQUIRED`. A request that
*should* have been tenant-scoped but wasn't does not fail loudly here — it
quietly evaluates against global grants only. If an operation must not run
unscoped, assert it yourself with `requireTenant()` / `requireTenantId()` from
[`@basaltkit/tenancy`](https://www.npmjs.com/package/@basaltkit/tenancy), which
throw `TenantRequiredError` (`TENANT_REQUIRED`, HTTP 400). And to bind the
caller to the resolved tenant at all, register
`tenantMembershipPlugin` from `@basaltkit/teams` — permissions answer *what* a
user may do, not *which* tenant they belong to.

`Gate` methods:

| Method | Returns | Description |
|---|---|---|
| `can(user, permission, resource?)` | `Promise<boolean>` | Checks; with a resource and an applicable policy, the policy decides. |
| `authorize(user, permission, resource?)` | `Promise<void>` | Like `can`, but throws `PermissionDeniedError` (403). |
| `hasRole(user, role)` | `Promise<boolean>` | Does the user actually hold the role (in the current scope or global)? Membership only — the `superAdmin` bypass does **not** make it `true`. |
| `isSuperAdmin(user)` | `Promise<boolean>` | Whether the `superAdmin` callback lets the user bypass every check (`false` without one). |
| `describeAccess(user)` | `Promise<AccessReport>` | Everything the user may do right now, with provenance — what `GET /me/access` answers (see [What may I do?](#what-may-i-do)). Side-effect free. |
| `effectiveRoles(userId)` | `Promise<string[]>` | Every role the user holds across the scopes a check consults (current + global). |
| `audienceRoles(userId)` | `Promise<string[]>` | The roles the audience guard confines on: the current scope's, or the global ones when the current scope has none. |
| `assignRole` / `removeRole(userId, role, scope?)` | `Promise<void>` | Store write + `permission:role_assigned` / `permission:role_removed` hook. `scope` defaults to the current scope (see [Writes need a tenant or an explicit scope](#writes-need-a-tenant-or-an-explicit-scope)). |
| `grantToRole(role, permissions, scope?)` / `grantToUser(userId, permissions, scope?)` | `Promise<void>` | Store write + `permission:granted` hook. Prefer these over the store's methods so changes reach the audit trail. |
| `register(policy)` | `this` | Registers a policy after construction. |
| `grantTemporarily(userId, permissions, options?)` | `Promise<TemporaryGrant>` | Time-boxed extra permissions. `options`: `{ expiresAt?, ttlMs?, scope?, grantedBy?, reason? }` — `expiresAt` wins over `ttlMs`; one of them is required, and the deadline must be a finite time in the future (`TypeError` otherwise). Requires a `temporaryGrants` store. |
| `delegate({ from, to, permissions, scope?, expiresAt? })` | `Promise<Delegation>` | Lets `to` act with a subset of `from`'s authority. `permissions` accepts patterns; `'*'` means everything the delegator can do. Omit `expiresAt` for an open-ended delegation. Requires a `delegations` store. |

### `AccessStore` interface

Implement this on top of your database. `scope` is the tenant id or `GLOBAL_SCOPE`:

| Method | Description |
|---|---|
| `getUserRoles(userId, scope)` | The user's roles in the scope. |
| `getUserPermissions(userId, scope)` | The user's direct permissions. |
| `getRolePermissions(role, scope)` | A role's permissions. |
| `assignRole(userId, role, scope)` / `removeRole(...)` | Assign/remove a role. |
| `grantToRole(role, permissions, scope)` | Grant permissions to a role. |
| `grantToUser(userId, permissions, scope)` | Grant direct permissions. |

`MemoryAccessStore` is the in-memory implementation (dev/tests).

### Other exports

| Export | Description |
|---|---|
| `permissionMatches(granted, requested)` | Wildcard matching. |
| `gate.rolePermissions(role, scope)` | The permissions `role` carries when held in `scope`: store grants in that scope + `roleCatalog` + (opt-in) the global definition. Used by checks and `GET /me/access`. |
| `definePolicy<T, W>(resource, checks, { filters }?)` | Creates a `Policy<T, W>` (checks: `(user, resource) => boolean \| Promise<boolean>`; optional `filters`: the list form, action → `(user) => W \| true \| false`, each key paired with a check). |
| `GLOBAL_SCOPE` | The string `'@global'` (was `'global'` before 1.5). |
| `LEGACY_GLOBAL_SCOPE` | The string `'global'` — the old global scope, read only with `readLegacyGlobalScope`. |
| `isReservedScope(id)` | `true` for ids a tenant must not use (`'@global'`, `'global'`). |
| `currentScope()` | The scope of the current request (tenant id or `GLOBAL_SCOPE`); throws `ReservedScopeError` for a reserved tenant id. |
| `ReservedScopeError` | `PERMISSION_SCOPE_RESERVED` (403). |
| `ScopeRequiredError` | `PERMISSION_SCOPE_REQUIRED` (400) — a scope-less grant write outside a tenant while tenancy is active. |
| `definePolicy` snapshot | Checks (and `filters`) are copied into a prototype-free lookup of the object's own function entries; a non-function check or filter, a resource containing `:`, or a filter with no check of the same action throws `TypeError`. |
| `GATE` | DI token for the Gate in the container. |
| `gate.hasPolicy(permission)` | `true` when a registered policy check decides exactly `resource:action` — a pure lookup. |
| `gate.listFilter<W>(user, permission)` | The list form of `can(user, permission, resource)`: `{ kind: 'unrestricted' }`, `{ kind: 'none' }` or `{ kind: 'where', where }` from the policy's `filters`. Fails closed with `MissingPolicyFilterError`; `W` is a caller-side type assertion. |
| `ListFilter<W>`, `PolicyFilter<W>`, `PolicyOptions<W>` | Types of `listFilter`'s answer and of `definePolicy`'s `filters`. |
| `canResource<T>(permission?)` | The resource the `meta.can` guard loaded for this request. Pass the permission when requirements loaded different resources. Throws `CanResourceUnavailableError` when none was loaded. |
| `CanMeta`, `CanRequirement`, `CanResourceLoader`, `CanResourceInput`, `CanResourceNotFound` | Types of the `meta.can` value and its resource requirement. |
| `PolicyUser` | Minimal user type: `{ id: string; [key: string]: unknown }`. |
| `Policy`, `PolicyCheck` | Policy types. Advanced. |
| `TemporaryGrant`, `TemporaryGrantStore`, `MemoryTemporaryGrantStore` | Time-boxed grants: the record, the contract, the in-process implementation. |
| `Delegation`, `DelegationStore`, `MemoryDelegationStore` | Delegation: the record, the contract, the in-process implementation. |
| `accessRoutes(options?)` | `GET /me/access` (see [What may I do?](#what-may-i-do)). `options`: `{ path?, store? }`. |
| `AccessReport`, `AccessGrant` | The `describeAccess()` / `GET /me/access` answer and one provenance entry of it. |

### Route guard — `meta.audience`

A permission is a capability, not a surface. `matter:read` cannot tell "read my
own case in the client portal" from "read the case with the litigation strategy
in it", so a role granted the first also passes the guard on the second — which
is how a portal client once received `200 OK` on an internal listing.

```ts
permissionsPlugin({
  store,
  audiences: { portal: { roles: ['client'], allow: ['portal', 'public'] } },
})

route({ url: '/portal/matters', meta: { can: 'matter:read', audience: 'portal' } })
```

**A route that declares no audience is unreachable by a confined role**, and
that direction is the point: marking the internal routes instead fails the first
time somebody adds one without thinking about portals.

A caller is confined only when **every** role they hold is named by some rule.
One unnamed role — a lawyer who is also a client of the firm — and audiences say
nothing about them. Two confined roles reach the union of their rules. "Every
role they hold" means the roles held in the current tenant, or — when the tenant
grants none — those held in `GLOBAL_SCOPE` (`gate.audienceRoles()`). So a
confined role assigned globally confines inside every tenant where the user has
no role of their own, and an unnamed global baseline role (a `user` every signup
gets) does not un-confine a tenant's client.

Audiences narrow, never widen: the permission check runs regardless, so naming
an audience is not a way in. Omit `audiences` and nothing changes.

### Route guard — `meta.can`

`permissionsPlugin` registers a route guard. A route carrying `meta.can`
requires an authenticated `ctx().user` (otherwise **401 `AUTH_REQUIRED`**) who
holds the declared permission (otherwise **403 `PERMISSION_DENIED`**).

`meta.can` accepts a permission, a [resource requirement](#resource-requirements-policies-in-the-guard),
or an array mixing both:

```ts
meta: { can: 'projects:delete' }                       // one permission
meta: { can: ['projects:delete', 'billing:read'] }     // ALL of them (all-of, not any-of)
meta: { can: { permission: 'projects:update', resource: loadProject } } // the policy decides
```

An array is **conjunctive** — every entry must pass. There is no any-of form;
express that as a wildcard permission, or check inside the handler.

Anything else is **unenforceable and fails closed**: `can: true`, `can: 42`,
`can: []`, `can: ['a', 3]`, `can: ['']`, a requirement without a loader — all throw `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP **500**) on *every* request to that route. This
replaced a historic fail-open where a non-string simply skipped the check —
a route that declares authorization it cannot enforce must never serve.

The plugin also claims `'can'` and `'audience'` in the `http:guarded-meta`
bucket, so a route declaring either in an app that never registered
`permissionsPlugin` fails loud **at boot** with `UnguardedRouteMetaError`
(`HTTP_UNGUARDED_ROUTE_META`) rather than serving unchecked. See `@basaltkit/http` for the
`allowUnguardedMeta` escape hatch.

It also registers a **side-effect-free visibility check** for `meta.can` in
`http:route-visibility`, so listings such as `@basaltkit/mcp`'s `tools/list`
hide routes whose permission(s) the caller lacks. It runs `gate.can(user,
permission)` per plain entry — grant reads only, never a `permission:denied` hook, so
listings stay out of the audit trail (`superAdmin` runs too: keep it pure). No
user or a malformed `meta.can` hides the route. A resource requirement is
**never loaded** by a listing (see below), and a resource-level `authorize()`
inside a handler is invisible to it too: such a tool stays listed and is
refused on the call. Visibility is never authorization.

#### Resource requirements (policies in the guard)

A plain `meta.can` is RBAC: the guard never passes a resource, so a policy
registered with `definePolicy` never runs there — `projects:*` lets its holder
update *every* project, whatever the ownership policy says. Declare the resource
instead and the guard enforces the policy:

```ts
import { canResource, definePolicy, permissionsPlugin } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>('projects', {
  update: (user, project) => project.ownerId === user.id,
})

permissionsPlugin({ store, policies: [ProjectPolicy as never] })

route({
  method: 'PATCH',
  url: '/projects/:id',
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string() }),
  meta: {
    can: {
      permission: 'projects:update',
      resource: ({ params }) => projects.findById(params.id), // null → 404
    },
  },
  // Already loaded and authorized by the guard — not loaded a second time.
  handler: ({ body }) => projects.rename(canResource<Project>(), body.name),
})
```

What the guard does, in order:

1. no authenticated user → **401 `AUTH_REQUIRED`**, before anything is loaded;
2. the plain-string entries of the array (if any) → `gate.authorize(user, permission)`, so a caller refused by RBAC never triggers a load;
3. each requirement: `resource(input)` loads the resource, then `gate.authorize(user, permission, resource)` — **the policy decides**, exactly as when you call the Gate by hand (grants are not consulted for that entry);
4. the resources are kept for the handler: `canResource()` returns the loaded one, `canResource('projects:publish')` picks one by permission when a route loaded several.

The loader receives `{ params, query, body, user, tenant, container, request, route }`.
`params`, `query` and `body` are parsed by the route's schemas exactly as the
handler gets them (invalid input is the usual **400 `HTTP_VALIDATION`**, before
any load; keep schema transforms pure — they run once for the loader and once
for the handler). The body is `undefined` for `upload()`/`rawBody()` routes.
Requirements that share a loader function load once per request.

| Situation | Answer |
|---|---|
| Loader returns `null`/`undefined` | **404 `RESOURCE_NOT_FOUND`** (`ResourceNotFoundError`). With `notFound: 'deny'` on the requirement (or `resourceNotFound: 'deny'` on the plugin): **403 `PERMISSION_DENIED`**, audited — a caller cannot tell a missing id from a forbidden one. |
| Loader throws | The error propagates unchanged (a 500 unless it carries its own `status`). Never an allow. |
| Policy returns anything but `true` | **403 `PERMISSION_DENIED`** + `permission:denied`. |
| No policy decides `permission` | Refused **at boot** (below). At runtime (a `runRoute()` without an adapter) the Gate throws `MissingPolicyError`. With `onMissingPolicy: 'rbac'` it boots and the entry is answered from the grants (still loading, still 404 on a missing resource). |

To require the grant **and** the policy, mix both forms:
`can: ['projects:update', { permission: 'projects:update', resource: load }]`.

**Boot validation.** The plugin registers an `http:meta-validators` check, which
every adapter runs over its routes before serving: a malformed requirement (no
loader, a bad permission, an unknown key such as `resolve`, a `notFound` other
than `'not-found' | 'deny'`, a non-string/non-object entry beside it) or a
requirement whose `resource:action` no registered policy decides refuses the
boot with `InvalidRouteMetaError` — unless `onMissingPolicy: 'rbac'`. Register
policies in `permissionsPlugin({ policies })` (or before the adapter boots). The
string forms keep their runtime fail-closed only, as before.

**Listings.** `tools/list` must stay free of side effects, so a listing never
calls a loader or a policy. A requirement decided by a policy raises no
objection for an authenticated caller (an owner may pass holding no grant at
all) — the tool is listed and the guard decides on the call. Plain entries
beside it still hide the tool from callers lacking them, so the mixed form
above also lists by the grant. Without a policy, under `onMissingPolicy:
'rbac'` visibility answers from the grants; under `'error'` the route is
hidden (every call would fail).

Works the same on Fastify, Express and Hono, and through `@basaltkit/mcp` tool
calls — it is a route guard of the shared pipeline.

### Failure modes & troubleshooting

| Error | Code | HTTP | When |
|---|---|---|---|
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | A `meta.can` route ran with no `ctx().user` (or one without a non-empty string `id`); also `can`/`authorize`/`hasRole` given such a user. |
| `ScopeRequiredError` | `PERMISSION_SCOPE_REQUIRED` | 400 | A grant write with no `scope`, no tenant in the context, and tenancy active. |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | `gate.authorize()` (or the guard) found the user lacks the permission. Carries the permission in its message. |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | `meta.can` is not a permission, a valid resource requirement, or a non-empty array of those. Names the route and describes what it received. |
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | 404 | A resource-aware `meta.can` loader returned `null`/`undefined` (unless `notFound: 'deny'`). |
| `CanResourceUnavailableError` | `PERMISSION_RESOURCE_UNAVAILABLE` | 500 | `canResource()` was called where the guard loaded no resource (or, without a permission, several different ones). |
| `InvalidRouteMetaError` | `HTTP_INVALID_ROUTE_META` | boot | A resource-aware `meta.can` is malformed, or no policy decides its permission (under `onMissingPolicy: 'error'`). Raised by the adapter, from `@basaltkit/http`. |
| `MissingPolicyError` | `PERMISSION_POLICY_MISSING` | 500 | `can`/`authorize` was given a resource but no policy check matches `resource:action` — the ABAC rule you intended would be skipped. |
| `MissingPolicyFilterError` | `PERMISSION_FILTER_MISSING` | 500 | `gate.listFilter(user, 'resource:action')` found no list filter for exactly that permission — never answered from RBAC or `onMissingPolicy`. |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.can` and `permissionsPlugin` isn't registered. Raised by the adapter, from `@basaltkit/http`. |

All the runtime errors declare a `status`, so adapters return the code above
with the real error code in the body.

- **`PERMISSION_META_INVALID` after refactoring a route** — you most likely
  wrote `can: true` or a computed array that came out empty. Both are
  unenforceable; the guard refuses rather than skipping.
- **`PERMISSION_POLICY_MISSING` after an upgrade** — that `can(user, perm, resource)`
  call was already answering silently from RBAC. Check both halves of
  `resource:action` against `definePolicy`, register the missing check, or stop
  passing the resource if the call really is plain RBAC.
- **`PERMISSION_FILTER_MISSING` from a listing** — the policy has no list form
  for that action. Add `filters: { <action>: (user) => … }` as the third
  argument of its `definePolicy` call, next to the check, or fix the
  `resource:action` spelling. There is deliberately no fallback.
- **403 on a permission you definitely granted** — check the *scope*. A grant in
  `'acme'` only applies when the check runs in the `acme` tenant; use
  `GLOBAL_SCOPE` for grants that apply everywhere.
- **A delegated user is denied something the delegator can do** — delegation is
  bounded by the delegator's *direct* permissions and doesn't chain. If the
  delegator only holds it by delegation themselves, it doesn't pass through.
- **`PERMISSION_SCOPE_REQUIRED` from a seed script or admin endpoint** — a
  multi-tenant app wrote a grant outside any tenant without saying where. Pass
  the tenant id, or `GLOBAL_SCOPE` for a platform-wide grant.

### Hooks & events

With `permissionsPlugin` (or a `hooks` bus passed to `new Gate`), the Gate
emits — and `auditPlugin` captures by default (`permission:**`):

| Hook | Payload | When |
|---|---|---|
| `permission:denied` | `{ userId, permission, scope }` | `authorize()` refused, a `meta.can` route refused, or an audience refused (`permission` is `audience` / `audience:<name>`). |
| `permission:role_assigned` / `permission:role_removed` | `{ userId, role, scope }` | `gate.assignRole()` / `gate.removeRole()`. |
| `permission:granted` | `{ role? , userId?, permissions, scope, expiresAt? }` | `gate.grantToRole()`, `gate.grantToUser()`, `gate.grantTemporarily()`. |
| `permission:delegated` | `{ fromUserId, toUserId, permissions, scope, expiresAt? }` | `gate.delegate()`. |

Writes made straight on the `AccessStore` bypass these hooks. Membership-driven
role changes are emitted by `@basaltkit/teams` (`team:joined`,
`team:role_changed`, `team:member_removed`); wire the Gate's store to teams via
the `access` option there to mirror them into role grants.

## Common errors and solutions (FAQ)

**"403 PERMISSION_DENIED but I granted the permission."** Check the **scope**: a grant in the `'acme'` scope only applies when the request runs in the `acme` tenant. If you want it to apply everywhere, use `GLOBAL_SCOPE`.

**"401 AUTH_REQUIRED on a route with meta.can."** The guard needs `ctx().user` — register an authentication plugin first (e.g. `@basaltkit/auth`) and send credentials in the request.

**"`projects:*` doesn't cover `projects:sub:deep`."** Intentional: the wildcard covers one segment; the number of segments must match. Use `projects:sub:*` or `*`.

**"The policy isn't being called."** A policy only decides when a **resource** is passed as the third argument to `can`/`authorize`, and the permission name must be `resource:action` with the same resource name as the policy. A plain `meta.can: 'projects:update'` passes none — declare the resource on the route instead (`meta.can: { permission: 'projects:update', resource: (input) => load(input.params.id) }`, see [Resource-aware `meta.can`](#resource-requirements-policies-in-the-guard)), or call the Gate inside the handler with the resource.

**"Grants disappear on restart."** `MemoryAccessStore` lives in memory. Implement `AccessStore` on top of your database.

## How it connects to other modules

- **@basaltkit/auth** — authenticates and sets `ctx().user`, which the `meta.can` guard consumes. Auth = who you are; permissions = what you can do.
- **@basaltkit/tenancy** — sets `ctx().tenant`; the Gate uses it as the default scope, isolating permissions per tenant.
- **@basaltkit/teams** — can mirror team memberships as roles: `MemoryAccessStore` (or your own `AccessStore`) satisfies teams' `RoleAssigner` interface, so "being an admin of the acme team" automatically becomes the `admin` role in the `acme` scope.
- **@basaltkit/core / @basaltkit/fastify** — container, context, and execution of the HTTP guards.

Guides: [Authorization](/guide/authorization) · [Teams](/guide/teams) · [Tenancy](/guide/tenancy) · [Auth](/guide/auth).
