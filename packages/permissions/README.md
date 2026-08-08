# @machize/permissions

Authorization for Machize applications: roles, wildcard permissions, resource-based policies, super admin, and route protection — in the style of Laravel's Spatie Permissions.

You need this module when different users can do different things in your application (e.g. only admins can delete projects).

## What this module solves

Authentication (knowing *who* the user is) isn't enough: you also need **authorization** — deciding *what* that user can do. Scattering `if (user.isAdmin)` throughout the code quickly becomes unmanageable. This module centralizes those decisions in one place, the **Gate**, which you ask: "can this user do `projects:delete`?".

The building blocks are: **permissions** (labels like `projects:delete`, with wildcard support — `projects:*` covers all project actions and `*` covers everything), **roles** (named sets of permissions, like `admin`, assigned to users), and **policies** (contextual rules about a specific resource, e.g. "only the project owner can edit it").

Everything is **scoped per tenant** by default: a permission granted within the "acme" tenant doesn't apply in the "globex" tenant. Grants in the `global` scope apply everywhere. Assignments live in an `AccessStore` — in memory for development, in your database in production.

## Installation

```bash
pnpm add @machize/permissions
```

## Get started in 5 minutes

1. **Create a store and grant permissions:**

```ts
import { Gate, MemoryAccessStore, GLOBAL_SCOPE } from '@machize/permissions'

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
import { createApp } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import { permissionsPlugin, MemoryAccessStore } from '@machize/permissions'

const store = new MemoryAccessStore()
await store.grantToUser('user-ada', ['projects:delete'], 'global')

const app = await createApp({
  plugins: [
    // ... an authentication plugin that sets ctx().user (e.g. @machize/auth)
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
import { MemoryAccessStore } from '@machize/permissions'

const store = new MemoryAccessStore()
await store.grantToRole('editor', ['articles:read', 'articles:write'], 'acme')
await store.assignRole('user-bob', 'editor', 'acme') // only applies in the acme tenant
await store.removeRole('user-bob', 'editor', 'acme')
```

You can also grant permissions directly to a user with `grantToUser(userId, permissions, scope)`.

### Per-tenant scope

When the Gate checks, it looks for grants in **two** scopes: the current scope and `GLOBAL_SCOPE` (`'global'`). The current scope, by default, is `ctx().tenant.id` set by `@machize/tenancy` — or `global` if there's no tenant. You can override it with the `scope` option:

```ts
import { Gate, MemoryAccessStore } from '@machize/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  scope: () => 'my-scope', // advanced: custom scope
})
```

### Policies (rules about a specific resource)

A **policy** decides by looking at the object in question — for example, "only the owner can edit." When you call `can()` with a third argument (the resource) and a policy exists for `resource:action`, the policy decides (grants are not consulted):

```ts
import { Gate, MemoryAccessStore, definePolicy } from '@machize/permissions'

interface Project { ownerId: string }

const ProjectPolicy = definePolicy<Project>('project', {
  update: (user, project) => project.ownerId === user.id,
})

const gate = new Gate({ store: new MemoryAccessStore(), policies: [ProjectPolicy as never] })
// or later: gate.register(ProjectPolicy as never)

await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'u9' })    // true
await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'other-user' }) // false
```

### Super admin

A function that, when it returns `true` for a user, authorizes everything (equivalent to Laravel's `Gate::before`):

```ts
import { Gate, MemoryAccessStore } from '@machize/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  superAdmin: (user) => user['owner'] === true,
})

await gate.can({ id: 'x', owner: true }, 'any:thing') // true, always
```

### Using the Gate inside handlers

The plugin registers the Gate in the container under the `GATE` token:

```ts
import { ctx, type Container } from '@machize/core'
import { GATE } from '@machize/permissions'

const gate = (ctx().container as Container).get(GATE)
await gate.authorize(ctx().user!, 'billing:write')
```

## API reference

### `Gate` / `permissionsPlugin(options)`

Options (`GateOptions` = `PermissionsPluginOptions`):

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `AccessStore` | Yes | — | Where grants live (your DB in production). |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | No | — | Shortcut: `true` authorizes everything. |
| `scope` | `() => string` | No | `ctx().tenant.id` or `'global'` | Current scope for checks. |
| `policies` | `Policy<never>[]` | No | `[]` | Policies registered upfront. |

`Gate` methods:

| Method | Returns | Description |
|---|---|---|
| `can(user, permission, resource?)` | `Promise<boolean>` | Checks; with a resource and an applicable policy, the policy decides. |
| `authorize(user, permission, resource?)` | `Promise<void>` | Like `can`, but throws `PermissionDeniedError` (403). |
| `hasRole(user, role)` | `Promise<boolean>` | Does the user have the role (in the current scope or global)? |
| `register(policy)` | `this` | Registers a policy after construction. |

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
| `PermissionDeniedError` | `PERMISSION_DENIED`, HTTP 403. |
| `AuthRequiredGuardError` | `AUTH_REQUIRED`, HTTP 401 — a `meta.can` route without a user. |

### Route guard

`permissionsPlugin` registers a guard: any route with `meta: { can: 'some:permission' }` requires a `ctx().user` (otherwise 401) with that permission (otherwise 403). The guard only accepts a single string in `meta.can`.

## Common errors and solutions (FAQ)

**"403 PERMISSION_DENIED but I granted the permission."** Check the **scope**: a grant in the `'acme'` scope only applies when the request runs in the `acme` tenant. If you want it to apply everywhere, use `GLOBAL_SCOPE`.

**"401 AUTH_REQUIRED on a route with meta.can."** The guard needs `ctx().user` — register an authentication plugin first (e.g. `@machize/auth`) and send credentials in the request.

**"`projects:*` doesn't cover `projects:sub:deep`."** Intentional: the wildcard covers one segment; the number of segments must match. Use `projects:sub:*` or `*`.

**"The policy isn't being called."** A policy only decides when you pass the **resource** as the third argument to `can`/`authorize`, and the permission name must be `resource:action` with the same resource name as the policy. The `meta.can` guard doesn't pass resources — for policies, call the Gate inside the handler.

**"Grants disappear on restart."** `MemoryAccessStore` lives in memory. Implement `AccessStore` on top of your database.

## How it connects to other modules

- **@machize/auth** — authenticates and sets `ctx().user`, which the `meta.can` guard consumes. Auth = who you are; permissions = what you can do.
- **@machize/tenancy** — sets `ctx().tenant`; the Gate uses it as the default scope, isolating permissions per tenant.
- **@machize/teams** — can mirror team memberships as roles: `MemoryAccessStore` (or your own `AccessStore`) satisfies teams' `RoleAssigner` interface, so "being an admin of the acme team" automatically becomes the `admin` role in the `acme` scope.
- **@machize/core / @machize/fastify** — container, context, and execution of the HTTP guards.
