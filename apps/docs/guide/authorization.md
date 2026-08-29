# Authorization (permissions)

Authentication tells you *who* a user is; [`@basaltkit/permissions`](/reference/packages/permissions)
decides *what* they can do. It centralizes those decisions in one **Gate** you ask
"can this user do `projects:delete`?" — with roles, wildcard permissions and
resource policies, all **tenant-scoped** by default.

[[toc]]

## Mental model

The Gate is **default-deny**: a check passes only when something explicitly
grants it — a permission granted to the user, a role the user holds, an active
temporary grant or delegation, or a matching resource policy. Nothing granted →
`false`. Grants are looked up in the **current tenant scope and the global
scope** (`GLOBAL_SCOPE`); nothing else.

Route protection is split between meta keys and the plugin whose guard enforces
each one:

| Route meta | Enforced by | Rejects with |
| --- | --- | --- |
| `meta.auth` | `authPlugin` ([auth guide](/guide/auth)) | `401 AUTH_REQUIRED` |
| `meta.can` | `permissionsPlugin` (this page) | `403 PERMISSION_DENIED` |
| `meta.teamRole` | `teamsPlugin` ([teams guide](/guide/teams)) | `403 TEAM_ROLE_REQUIRED` |
| `meta.scopes` | `apiKeysPlugin` ([auth guide](/guide/auth)) | `403 SCOPE_REQUIRED` |
| `meta.subscribed` | `subscriptionsPlugin` ([billing guide](/guide/billing)) | `402 NOT_SUBSCRIBED` |
| `meta.feature` | `subscriptionsPlugin` ([billing guide](/guide/billing)) | `402 FEATURE_UNAVAILABLE` |

Declaring one of these keys without registering the enforcing plugin does not
silently serve the route unprotected — the adapter refuses to **boot** with
`UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`). See
[Failure modes](#failure-modes-troubleshooting) and the
[adapters guide](/guide/adapters).

## Grant and ask

Permissions are labels like `projects:delete`; roles are named sets of them. Grants
live in an `AccessStore` (in-memory for dev, your database in production).

```ts
import { Gate, MemoryAccessStore, GLOBAL_SCOPE } from '@basaltkit/permissions'

const store = new MemoryAccessStore()
await store.grantToRole('admin', ['projects:*', 'billing:read'], GLOBAL_SCOPE)
await store.assignRole('user-ada', 'admin', GLOBAL_SCOPE)

const gate = new Gate({ store })
await gate.can({ id: 'user-ada' }, 'projects:delete') // true — projects:* covers it
await gate.can({ id: 'user-bob' }, 'projects:delete') // false
```

`gate.authorize(user, perm)` is the throwing variant — it raises
`PermissionDeniedError` (`403 PERMISSION_DENIED`) instead of returning `false`.
`gate.hasRole(user, role)` answers role membership directly.

### Wildcards match segment by segment

A granted pattern is compared to the requested permission **one `:`-separated
segment at a time**, and the segment counts must match:

```ts
'projects:*'  covers 'projects:delete'      // ✅ same depth, second segment wildcarded
'projects:*'  covers 'projects:read'        // ✅
'projects:*'  does NOT cover 'projects:delete:all' // ❌ 2 segments vs 3 — no match
'*'           covers everything             // ✅ the one exception: a super admin
```

So a two-level grant never silently absorbs a deeper, more specific permission
you add later — grant `projects:*:*` (or the exact string) if you mean the
deeper level. The bare `'*'` matches any permission regardless of depth.

## Resource policies

For rules that depend on the *specific* resource — "only the project owner can edit
it" — define a policy: a **resource name** plus a map of **actions** to check
functions. A check receives the user and the resource instance:

```ts
import { definePolicy } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>('project', {
  update: (user, project) => project.ownerId === user.id,
  delete: (user, project) => project.ownerId === user.id,
})

gate.register(ProjectPolicy)

// Pass the resource: 'project:update' → the 'project' policy's 'update' check runs
await gate.can({ id: 'u1' }, 'project:update', project)
```

When you pass a resource, the Gate splits the permission into
`resource:action`, looks up the policy registered for that resource, and lets
its check decide. Policies can be registered up front via the `policies` option
or later with `gate.register(...)`; checks may be async.

::: warning No policy ⇒ the check falls through to RBAC
If no policy is registered for the resource (or the policy has no check for
that action), passing a resource does **not** fail the check — the Gate falls
back to the granted permission strings, exactly as if no resource were passed.
A user granted `project:update` would pass even for a project they don't own.
If ownership must be enforced, make sure the policy is registered — and test
the deny case.
:::

## Protect routes

Register `permissionsPlugin` and declare the permission a route needs with `meta.can` —
the plugin guards it automatically, reading the authenticated user from context:

```ts
import { permissionsPlugin } from '@basaltkit/permissions'

app.use(permissionsPlugin({ store }))

route({
  method: 'DELETE', url: '/projects/:id',
  meta: { can: 'projects:delete' }, // 403 unless the user has it
  async handler({ params }) { /* … */ },
})
```

An anonymous request to a `meta.can` route is rejected with `401 AUTH_REQUIRED`
before any permission check — pair with [`authPlugin`](/guide/auth) so
`ctx().user` is populated.

`meta.can` accepts a single permission string or an **array — the caller must
hold all of them**:

```ts
meta: { can: ['reports:read', 'reports:export'] } // 403 unless the user has BOTH
```

Any other shape (`can: true`, a number, an empty or mixed array) is
unenforceable and **fails closed**: the guard throws `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP 500) on every request instead of silently
skipping the check. And declaring `meta.can` without registering
`permissionsPlugin` fails at **boot** — see the adapters guide.

## Tenant scoping

Grants are **per tenant** by default: `projects:*` granted in `acme` doesn't apply in
`globex`. Every check consults exactly two scopes — the current one (by default
`ctx().tenant.id`, falling back to `GLOBAL_SCOPE` outside a tenant context) and
the global scope. Use `GLOBAL_SCOPE` for grants that apply everywhere, and the
`scope` option to derive the current scope differently. In production, swap
`MemoryAccessStore` for a durable `AccessStore`
(`@basaltkit/permissions-prisma` / `-sqlite` ship in the ecosystem).

## Temporary grants and delegation

Two time-boxed mechanisms sit on top of the standing grants. Both are **opt-in**
— each needs its store wired into the Gate (in-memory versions ship for
dev/tests):

```ts
import {
  Gate, MemoryAccessStore, MemoryTemporaryGrantStore, MemoryDelegationStore,
} from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  temporaryGrants: new MemoryTemporaryGrantStore(),
  delegations: new MemoryDelegationStore(),
})
```

**Temporary grants** give a user extra permissions until an expiry —
break-glass access, a time-boxed task. Active grants are added to the user's
own permissions during the check:

```ts
const grant = await gate.grantTemporarily('user-bob', ['deploys:approve'], {
  ttlMs: 60 * 60_000,          // or an absolute `expiresAt` (epoch ms)
  grantedBy: 'user-ada',       // optional audit fields
  reason: 'covering on-call',
})
// after expiry the grant is inert; revoke earlier via the store: store.revoke(grant.id)
```

**Delegation** lets one user act with a subset of *another user's* authority:

```ts
await gate.delegate({
  from: 'user-ada',                // whose authority is lent
  to: 'user-bob',                  // who may act with it
  permissions: ['projects:*'],     // patterns; '*' = everything the delegator can do
  expiresAt: Date.now() + 86_400_000, // omit for open-ended
})
```

Delegated authority is bounded **at check time** by what the delegator can
*directly* do — a delegation never grants more than the delegator has *right
now* (revoke Ada's access and Bob's delegated access dies with it), and
delegations don't chain (Bob can't re-delegate Ada's authority; a check through
a delegation ignores the delegator's own incoming delegations).

## Options reference

`permissionsPlugin(options)` takes the same options as `new Gate(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `AccessStore` | — (required) | Where roles/permissions live — your database in production |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | — | Short-circuits **every** check to `true` when it returns `true` (Laravel's `Gate::before`) |
| `scope` | `() => string` | `ctx().tenant.id` ?? `GLOBAL_SCOPE` | Current scope; checks consult it plus `GLOBAL_SCOPE` |
| `policies` | `Policy[]` | `[]` | Resource policies registered up front (same as calling `gate.register`) |
| `temporaryGrants` | `TemporaryGrantStore` | off | Enables `grantTemporarily()` |
| `delegations` | `DelegationStore` | off | Enables `delegate()` |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |

The plugin registers the Gate under the `GATE` token, adds the `meta.can` guard,
and claims the `can` key in the adapters' boot-time guarded-meta check.

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | The check failed — nothing grants the permission in the current or global scope |
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | A `meta.can` route was hit with no authenticated user in context |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | `meta.can` has an unenforceable shape (`true`, a number, an empty/mixed array) — fails closed on every request |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.can` (or `auth`/`teamRole`/`scopes`/`subscribed`/`feature`) and no registered guard claims that key |

- **`PERMISSION_DENIED` for a user who "has the role"** — check the *scope*:
  a role assigned in tenant `acme` doesn't apply in `globex` or globally.
  Assign in `GLOBAL_SCOPE` for cross-tenant staff.
- **A policy check seems ignored** — the policy only runs when a *resource* is
  passed to `can`/`authorize` and a policy is registered for the resource name;
  otherwise the check falls through to RBAC (see the warning above).
- **`HTTP_UNGUARDED_ROUTE_META` at boot** — register `permissionsPlugin`, or,
  if authorization genuinely happens at an outer edge, opt out explicitly with
  the adapter option `allowUnguardedMeta: true` (or `['can']`). See the
  [adapters guide](/guide/adapters) and the [security guide](/guide/security).
