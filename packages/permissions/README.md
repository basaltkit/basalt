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
import { permissionsPlugin, MemoryAccessStore } from '@basaltkit/permissions'

const store = new MemoryAccessStore()
await store.grantToUser('user-ada', ['projects:delete'], 'global')

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

When the Gate checks, it looks for grants in **two** scopes: the current scope and `GLOBAL_SCOPE` (`'global'`). The current scope, by default, is `ctx().tenant.id` set by `@basaltkit/tenancy` — or `global` if there's no tenant. You can override it with the `scope` option:

```ts
import { Gate, MemoryAccessStore } from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  scope: () => 'my-scope', // advanced: custom scope
})
```

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

### Super admin

A function that, when it returns `true` for a user, authorizes everything (equivalent to Laravel's `Gate::before`):

```ts
import { Gate, MemoryAccessStore } from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  superAdmin: (user) => user['owner'] === true,
})

await gate.can({ id: 'x', owner: true }, 'any:thing') // true, always
```

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
database in production (the `Memory*` ones are per-process).

### Using the Gate inside handlers

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
| `onMissingPolicy` | `'error' \| 'rbac'` | `'error'` | What `can(user, perm, resource)` does when no policy check matches `resource:action`. `'error'` throws `MissingPolicyError` (fail closed); `'rbac'` falls back to the granted permission strings. |

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
| `hasRole(user, role)` | `Promise<boolean>` | Does the user have the role (in the current scope or global)? |
| `register(policy)` | `this` | Registers a policy after construction. |
| `grantTemporarily(userId, permissions, options?)` | `Promise<TemporaryGrant>` | Time-boxed extra permissions. `options`: `{ expiresAt?, ttlMs?, scope?, grantedBy?, reason? }` — `expiresAt` wins over `ttlMs`, and with neither the grant expires immediately. Requires a `temporaryGrants` store. |
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
| `definePolicy<T>(resource, checks)` | Creates a `Policy<T>` (checks: `(user, resource) => boolean \| Promise<boolean>`). |
| `GLOBAL_SCOPE` | The string `'global'`. |
| `GATE` | DI token for the Gate in the container. |
| `PolicyUser` | Minimal user type: `{ id: string; [key: string]: unknown }`. |
| `Policy`, `PolicyCheck` | Policy types. Advanced. |
| `TemporaryGrant`, `TemporaryGrantStore`, `MemoryTemporaryGrantStore` | Time-boxed grants: the record, the contract, the in-process implementation. |
| `Delegation`, `DelegationStore`, `MemoryDelegationStore` | Delegation: the record, the contract, the in-process implementation. |

### Route guard — `meta.can`

`permissionsPlugin` registers a route guard. A route carrying `meta.can`
requires an authenticated `ctx().user` (otherwise **401 `AUTH_REQUIRED`**) who
holds the declared permission (otherwise **403 `PERMISSION_DENIED`**).

`meta.can` accepts `string | string[]`:

```ts
meta: { can: 'projects:delete' }                       // one permission
meta: { can: ['projects:delete', 'billing:read'] }     // ALL of them (all-of, not any-of)
```

An array is **conjunctive** — the guard calls `gate.authorize()` once per entry
and every one must pass. There is no any-of form; express that as a wildcard
permission, or check inside the handler.

Anything else is **unenforceable and fails closed**: `can: true`, `can: 42`,
`can: []`, `can: ['a', 3]`, `can: ['']` all throw `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP **500**) on *every* request to that route. This
replaced a historic fail-open where a non-string simply skipped the check —
a route that declares authorization it cannot enforce must never serve.

The plugin also claims `'can'` in the `http:guarded-meta` bucket, so a route
declaring `meta.can` in an app that never registered `permissionsPlugin` fails
loud **at boot** with `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`)
rather than serving unchecked. See `@basaltkit/http` for the
`allowUnguardedMeta` escape hatch.

### Failure modes & troubleshooting

| Error | Code | HTTP | When |
|---|---|---|---|
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | A `meta.can` route ran with no `ctx().user`. |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | `gate.authorize()` (or the guard) found the user lacks the permission. Carries the permission in its message. |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | `meta.can` is not a non-empty string or a non-empty array of non-empty strings. Names the route and describes what it received. |
| `MissingPolicyError` | `PERMISSION_POLICY_MISSING` | 500 | `can`/`authorize` was given a resource but no policy check matches `resource:action` — the ABAC rule you intended would be skipped. |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.can` and `permissionsPlugin` isn't registered. Raised by the adapter, from `@basaltkit/http`. |

All four runtime errors declare a `status`, so adapters return the code above
with the real error code in the body.

- **`PERMISSION_META_INVALID` after refactoring a route** — you most likely
  wrote `can: true` or a computed array that came out empty. Both are
  unenforceable; the guard refuses rather than skipping.
- **`PERMISSION_POLICY_MISSING` after an upgrade** — that `can(user, perm, resource)`
  call was already answering silently from RBAC. Check both halves of
  `resource:action` against `definePolicy`, register the missing check, or stop
  passing the resource if the call really is plain RBAC.
- **403 on a permission you definitely granted** — check the *scope*. A grant in
  `'acme'` only applies when the check runs in the `acme` tenant; use
  `GLOBAL_SCOPE` for grants that apply everywhere.
- **A delegated user is denied something the delegator can do** — delegation is
  bounded by the delegator's *direct* permissions and doesn't chain. If the
  delegator only holds it by delegation themselves, it doesn't pass through.
- **Temporary grant expired instantly** — `grantTemporarily` with neither
  `ttlMs` nor `expiresAt` sets `expiresAt` to now.

### Hooks & events

`@basaltkit/permissions` emits **no hooks**. Membership-driven role changes are
emitted by `@basaltkit/teams` (`team:joined`, `team:role_changed`,
`team:member_removed`); wire the Gate's store to teams via the `access` option
there to mirror them into role grants.

## Common errors and solutions (FAQ)

**"403 PERMISSION_DENIED but I granted the permission."** Check the **scope**: a grant in the `'acme'` scope only applies when the request runs in the `acme` tenant. If you want it to apply everywhere, use `GLOBAL_SCOPE`.

**"401 AUTH_REQUIRED on a route with meta.can."** The guard needs `ctx().user` — register an authentication plugin first (e.g. `@basaltkit/auth`) and send credentials in the request.

**"`projects:*` doesn't cover `projects:sub:deep`."** Intentional: the wildcard covers one segment; the number of segments must match. Use `projects:sub:*` or `*`.

**"The policy isn't being called."** A policy only decides when you pass the **resource** as the third argument to `can`/`authorize`, and the permission name must be `resource:action` with the same resource name as the policy. The `meta.can` guard doesn't pass resources — for policies, call the Gate inside the handler.

**"Grants disappear on restart."** `MemoryAccessStore` lives in memory. Implement `AccessStore` on top of your database.

## How it connects to other modules

- **@basaltkit/auth** — authenticates and sets `ctx().user`, which the `meta.can` guard consumes. Auth = who you are; permissions = what you can do.
- **@basaltkit/tenancy** — sets `ctx().tenant`; the Gate uses it as the default scope, isolating permissions per tenant.
- **@basaltkit/teams** — can mirror team memberships as roles: `MemoryAccessStore` (or your own `AccessStore`) satisfies teams' `RoleAssigner` interface, so "being an admin of the acme team" automatically becomes the `admin` role in the `acme` scope.
- **@basaltkit/core / @basaltkit/fastify** — container, context, and execution of the HTTP guards.

Guides: [Authorization](/guide/authorization) · [Teams](/guide/teams) · [Tenancy](/guide/tenancy) · [Auth](/guide/auth).
