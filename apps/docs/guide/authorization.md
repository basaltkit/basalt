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
| `meta.tenant` | `tenancyPlugin` ([tenancy guide](/guide/tenancy)) | `404 TENANCY_NOT_RESOLVED` |

`meta.tenant` is the odd one out: it is not a guard but a *requirement*, read
while the tenant is resolved, and it works in both directions — `false` marks a
route central, `true` requires a tenant even when the app-wide default is off.
It is therefore not covered by the boot check below.

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
`gate.hasRole(user, role)` answers role membership directly — the roles the user
actually holds, in the current scope or globally. A `superAdmin` is **not** a
member of every role (it was before `@basaltkit/permissions` 4.0): the bypass
short-circuits `can()`/`authorize()`/`meta.can`, and `gate.isSuperAdmin(user)`
asks for it explicitly. Where `hasRole()` guarded an action, check the
permission instead.

### Wildcards match segment by segment

A granted pattern is compared to the requested permission **one `:`-separated
segment at a time**, and the segment counts must match:

```ts
'projects:*'  covers 'projects:delete'      // ✅ same depth, second segment wildcarded
'projects:*'  covers 'projects:read'        // ✅
'projects:*'  does NOT cover 'projects:delete:all' // ❌ 2 segments vs 3 — no match
'*'           covers everything             // ✅ the one exception: a super admin
'projects:*'  does NOT cover 'projects:'    // ❌ an empty segment never matches
```

So a two-level grant never silently absorbs a deeper, more specific permission
you add later — grant `projects:*:*` (or the exact string) if you mean the
deeper level. The bare `'*'` matches any permission regardless of depth.

A permission with an **empty segment** — `''`, `'projects:'`, `':read'`,
`'projects::read'` — is malformed and matches nothing, not even itself, and no
wildcard covers it (`hasEmptySegment()` tells you, from the same browser-safe
`@basaltkit/permissions/match` entry). The Gate refuses such a permission
outright: `can()`, every grant and `roleCatalog` throw a `TypeError`.

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

To enforce a policy on a route, declare the resource in `meta.can` — see
[Policies in the guard](#policies-in-the-guard-resource-requirements). The guard
then loads the resource and runs the policy, so no handler can forget the call.

::: danger No policy ⇒ the check fails closed
Passing a resource is an explicit statement that an ABAC rule should decide, so
if no policy is registered for that resource — or the policy has no check for
that action — the Gate throws `MissingPolicyError` (`PERMISSION_POLICY_MISSING`)
instead of answering from RBAC. It used to fall through silently, which meant a
typo (`project:updat`, or `projects:update` for a policy registered as
`project`) skipped the ownership rule entirely and a broad `project:*` grant
allowed the request.

The error names the permission and lists the registered policies. Fix it by
registering the check, correcting the `resource:action` spelling, or dropping
the resource argument if plain RBAC is what you meant. To restore the historic
fall-through — for apps that pass resources opportunistically — set
`onMissingPolicy: 'rbac'`.
:::

The match is exact. Only the policy's **own** actions count — `project:constructor`
or `project:toString` never reach `Object.prototype`, they are missing
policies — and only a two-segment `resource:action` selects a check:
`project:update:billing` is a different permission from `project:update`, so
the `update` check does not decide it. A check authorizes only when it returns
`true` (a truthy non-boolean denies). `can()` refuses a permission that is not
a non-empty string without whitespace or empty `:` segments (`TypeError`), and a user with no
non-empty string `id` is unauthenticated: `can`/`authorize`/`hasRole` throw
`AuthRequiredGuardError` (401) rather than evaluating — or crashing on — an
anonymous caller.

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

Any other shape (`can: true`, a number, an empty array, an entry that is
neither a permission nor a [resource requirement](#policies-in-the-guard-resource-requirements)) is
unenforceable and **fails closed**: the guard throws `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP 500) on every request instead of silently
skipping the check. And declaring `meta.can` without registering
`permissionsPlugin` fails at **boot** — see the adapters guide.

### Listings hide what the caller can't pass

The plugin also registers a **pure visibility check** for `meta.can` in
`http:route-visibility`, so listing surfaces — the [MCP `tools/list`](/guide/mcp#what-tools-list-shows)
— leave out routes whose permission(s) the caller lacks. It asks the guard's
own question, `gate.can(user, permission)` for every entry, in the current
scope (`superAdmin` short-circuits, as in the guard), but **without side
effects**: `can()` only reads grants — it never emits `permission:denied`, so a
listing never lands in the audit trail (keep `superAdmin` pure; it runs here
too). No user or a malformed `meta.can` hides the route, as the guard would
refuse it.

Policies never enter it — a listing never loads a resource. A
[resource requirement](#policies-in-the-guard-resource-requirements) decided by a
policy raises no objection for an authenticated caller (an owner may pass holding
no grant), and an ownership rule a handler runs itself is invisible too: such a
tool stays listed and is refused on the call. Visibility is never
authorization: every call still runs the guard.

### Policies in the guard (resource requirements)

A plain `meta.can: 'projects:update'` is RBAC — the guard passes no resource, so
a registered policy never runs and `projects:*` updates *every* project. Declare
the resource and the guard enforces the policy:

```ts
import { canResource, definePolicy, permissionsPlugin } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>('projects', {
  update: (user, project) => project.ownerId === user.id,
})

app.use(permissionsPlugin({ store, policies: [ProjectPolicy] }))

route({
  method: 'PATCH', url: '/projects/:id',
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string() }),
  meta: {
    can: {
      permission: 'projects:update',
      resource: ({ params }) => projects.findById(params.id), // null → 404
    },
  },
  // Loaded and authorized by the guard — read it back, don't load it again.
  async handler({ body }) {
    return projects.rename(canResource<Project>(), body.name)
  },
})
```

The guard answers `401` with no user (before any load), checks the plain
permissions of an array first (a caller refused by RBAC never triggers a load),
then for each requirement loads the resource and calls
`gate.authorize(user, permission, resource)`: **the policy decides**, exactly
as when you call the Gate by hand. The loader receives
`{ params, query, body, user, tenant, container, request, route }` — `params`,
`query` and `body` parsed by the route's schemas as the handler gets them
(invalid input is the usual `400`; keep schema transforms pure, they run for
the loader and again for the handler). Requirements sharing a loader load once.

| Situation | Answer |
| --- | --- |
| Loader returns `null` / `undefined` | `404 RESOURCE_NOT_FOUND` — or, with `notFound: 'deny'` (per requirement) / `resourceNotFound: 'deny'` (plugin), an audited `403 PERMISSION_DENIED`, so ids can't be probed |
| Loader throws | The error propagates unchanged — never an allow |
| Policy returns anything but `true` | `403 PERMISSION_DENIED` + `permission:denied` |
| No policy decides `permission` | Refused at **boot** (below); with `onMissingPolicy: 'rbac'` it boots and the grants decide |

Arrays mix both forms, all-of as before — require the grant **and** the policy
with `can: ['projects:update', { permission: 'projects:update', resource: load }]`.
With several requirements, `canResource('projects:publish')` picks one by
permission.

The plugin validates the resource form at **boot** through the
`http:meta-validators` bucket, which every adapter runs: a malformed
requirement (no loader, a bad permission, an unknown key, a bad `notFound`) or
one whose `resource:action` no registered policy decides refuses to start with
`InvalidRouteMetaError` (unless `onMissingPolicy: 'rbac'`). Register the
policies in `permissionsPlugin({ policies })`.

It behaves identically on Fastify, Express and Hono and through MCP tool calls
— it is a guard of the shared pipeline. Calling the Gate inside the handler
remains available for what a route can't declare: a second resource, a
decision on a value the handler computes, background jobs.

## Audiences — which surface a route belongs to

A permission is a capability, not a surface. `matter:read` cannot tell "read my
own case in the client portal" from "read the case with the litigation strategy
in it", so a role granted the first also passes the guard on the second.

That is not hypothetical: it is how an authenticated portal client received
`200 OK` on an internal listing, with their own case's strategy in the body.

`audiences` names the surfaces, and `meta.audience` says which one a route is:

```ts
app.use(permissionsPlugin({
  store,
  audiences: {
    portal: { roles: ['client'], allow: ['portal', 'public'] },
  },
}))

route({
  method: 'GET', url: '/portal/matters',
  meta: { can: 'matter:read', audience: 'portal' },
  async handler() { /* … */ },
})
```

### The default is the point

**A route that declares no audience is unreachable by a confined role.** Not
"reachable unless marked internal" — the other way round.

The obvious design is to mark the internal routes, and it fails the first time
somebody adds a route without thinking about portals. Marking the small,
deliberate surface a restricted role may reach is a list somebody maintains;
marking every route they may not is a list somebody forgets, once, silently.

### Who is confined

| The caller holds | Result |
| --- | --- |
| At least one role no rule names | **Unconfined.** Audiences say nothing about them |
| Only roles that rules name | **Confined** to the union of those rules' `allow` lists |
| No roles at all | Unconfined here — they hold no permission either, so `meta.can` already answers |

The middle row is why a lawyer who is also a client of their own firm keeps
working: refusing them would lock a member of staff out of their own workplace
the day the firm made them a client. Confine only those who have nothing else.

The union in the second row means two confined roles each grant reach to their
own surface, and holding both grants both — what neither names stays closed.

"The roles they hold" means the roles held in the current tenant, or — when
the tenant grants none — those held in `GLOBAL_SCOPE`
(`gate.audienceRoles(userId)`). A `client` role assigned globally confines its
holder inside every tenant where they hold no role of their own, not only
outside one. And an unnamed global baseline role (a `user` every signup gets)
does not un-confine a client inside their tenant: there the tenant's own roles
decide.

**Audiences narrow; they never widen.** The permission check runs regardless: a
caller without `matter:read` is refused on `/portal/matters` whether or not the
audience matches. Naming an audience is not a way in.

Omit `audiences` entirely and none of this applies.

## Tenant scoping

Grants are **per tenant** by default: `projects:*` granted in `acme` doesn't apply in
`globex`. Every check consults exactly two scopes — the current one (by default
`ctx().tenant.id`, falling back to `GLOBAL_SCOPE` outside a tenant context) and
the global scope. Use `GLOBAL_SCOPE` for grants that apply everywhere, and the
`scope` option to derive the current scope differently. In production, swap
`MemoryAccessStore` for a durable `AccessStore`
(`@basaltkit/permissions-prisma` / `-sqlite` ship in the ecosystem).

### One role catalogue for every tenant

A role's permissions are looked up **in the scope where the role is held**.
`@basaltkit/teams` mirrors memberships per tenant (`assignRole(user, 'owner',
tenantId)`), so a catalogue like "owner = `*`" granted once in `GLOBAL_SCOPE`
never reaches a tenant owner — and copying it into every tenant drifts. Define
it once instead:

```ts
permissionsPlugin({
  store,
  // (a) Code-defined, valid in every scope.
  roleCatalog: {
    owner: ['*'],
    admin: ['projects:*', 'members:invite'],
    member: ['projects:read'],
  },
  // (b) Or keep the catalogue in the store, under GLOBAL_SCOPE.
  inheritGlobalRolePermissions: ['admin', 'member'], // or `true` for every role
})
```

- **`roleCatalog`** — a role held in a scope grants its catalogue permissions
  **in that scope**: the owner of `acme` gets `*` in `acme`, nothing in
  `globex`, nothing globally. A role held in `GLOBAL_SCOPE` applies everywhere,
  as global roles always did.
- **`inheritGlobalRolePermissions`** — a tenant-held role also resolves its
  permissions from its `GLOBAL_SCOPE` definition, still granting only in that
  tenant. Prefer a list of role names when tenant admins can assign roles
  themselves: with `true`, assigning a globally defined `platform-admin` inside
  a tenant grants its global permission set there.

Both are unions with what the store grants the role in the tenant, use the same
wildcard rule, and grant **permissions, never roles**: `hasRole()`,
`effectiveRoles()` and audience confinement are unchanged. `GET /me/access`
(`accessRoutes()`) reports the same resolution (`gate.rolePermissions(role,
scope)`).

### The global scope can't be a tenant

`GLOBAL_SCOPE` is `'@global'` — a value no slug, hostname label or uuid can
take. (Before `@basaltkit/permissions` 1.5 it was `'global'`: grants are keyed
by tenant id, so the owner of a tenant *named* `global` held their roles in
every tenant.) The Gate refuses to evaluate a request whose tenant id is
`'@global'` or `'global'` — `ReservedScopeError`, `PERMISSION_SCOPE_RESERVED`,
403 — and `isReservedScope(id)` lets your tenant registry refuse those ids at
sign-up. The same error answers a request that carries a tenant with no
non-empty string id: that is a broken context, and falling back to the global
scope would evaluate (and let default-scoped `gate.assignRole()` write) the
platform-wide bucket.

**Upgrading from ≤ 1.4:** rows stored under the literal `'global'` are no
longer read as global. Migrate them:

```sql
UPDATE perm_user_roles       SET scope = '@global' WHERE scope = 'global';
UPDATE perm_user_permissions SET scope = '@global' WHERE scope = 'global';
UPDATE perm_role_permissions SET scope = '@global' WHERE scope = 'global';
```

`readLegacyGlobalScope: true` keeps reading them meanwhile — a transition aid:
while it is on, a tenant with id `'global'` writes global grants again, so
reserve that id before enabling it.

### Writes need a tenant (or an explicit scope)

`gate.assignRole()`, `removeRole()`, `grantToRole()`, `grantToUser()`,
`grantTemporarily()` and `delegate()` take an optional `scope`. Without one they
write to the current tenant. In a multi-tenant app — `tenancyPlugin` registered
— a scope-less write with **no tenant in the context** throws
`ScopeRequiredError` (`PERMISSION_SCOPE_REQUIRED`, 400) instead of falling back
to `GLOBAL_SCOPE`: a tenant-admin endpoint hit on a request whose tenant did not
resolve must not write a platform-wide grant.

```ts
await gate.assignRole(userId, 'admin')               // inside a tenant: that tenant
await gate.assignRole(userId, 'admin', GLOBAL_SCOPE) // a global grant: say so
```

Single-tenant apps (no tenancy plugin) are unaffected: scope-less writes still
land in `GLOBAL_SCOPE`. A custom `scope` option decides for itself, and
`allowGlobalWrites: true` restores the old fallback wholesale. A Gate built by
hand (`new Gate(...)`) learns that tenancy is active from the `tenancyActive`
option; `permissionsPlugin` wires it from `tenancyPlugin`'s marker.

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

A temporary grant needs a deadline: `grantTemporarily()` throws a `TypeError`
without `ttlMs` or `expiresAt` (it used to write an already-expired grant), and
refuses a deadline that is not a finite time in the future — `Infinity` is a
standing grant, so use `grantToUser()` for that.

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

The Gate does not trust its stores on any of this: whatever `activeFor()` /
`activeTo()` return is re-checked against the user, the scope and the Gate's
own clock (`now`), so a durable store that forgets its `expires_at > ?` filter
cannot turn a time-boxed grant into a standing one.

In production back both with a database — the `Memory*` stores are per-process,
so a grant or delegation dies with the process and is invisible to other
instances. `@basaltkit/permissions-prisma` and `@basaltkit/permissions-sqlite`
return durable ones next to the access store (see
[Persistence](/guide/persistence)):

```ts
const p = prismaAccessStore(prisma) // or sqliteAccessStore('./data/permissions.db')
permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
```

## What may I do? — `GET /me/access`

`accessRoutes()` adds `GET /me/access`: the caller's roles and permissions, so
the interface hides controls that would return `403` — and shows the ones that
open. It is not a security surface (every request is still decided by the Gate)
and it has no `meta.auth`: an anonymous caller gets an empty answer, not a `401`.

```ts
fastifyPlugin({ routes: [...accessRoutes(), ...myRoutes] })
```

The answer is `gate.describeAccess(user)`, and it covers **every source a check
honours**: grants in the current tenant *and* in `GLOBAL_SCOPE` (plus the legacy
global scope when `readLegacyGlobalScope` is on), the role catalogue and
inherited global definitions, live temporary grants, live delegations — already
narrowed to what the delegator holds — and the `superAdmin` bypass:

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

- `roles` — held in the current scope or globally (what `hasRole()` answers `true` for);
- `permissions` — sorted and deduplicated; `permitted(permissions, p)` from
  `@basaltkit/permissions/match` gives the same answer as `gate.can(user, p)`.
  A super admin gets `'*'`;
- `grants` — each permission's `source` (`'direct'`, `'role'`, `'temporary'`,
  `'delegation'`, `'super-admin'`), the `scope` it lives in, and `role`, `id`,
  `fromUserId`, `expiresAt` where they apply. A delegated permission expires at
  the earlier of the delegation's deadline and that of the delegator's
  temporary grant it rests on. Refetch before the earliest `expiresAt`.

Before `@basaltkit/permissions` 4.0 the route read only the current tenant's
standing grants, so a global grant, a temporary grant, a delegation or the
super-admin bypass opened the door on the server while the menu hid it.

## Options reference

`permissionsPlugin(options)` takes the same options as `new Gate(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `AccessStore` | — (required) | Where roles/permissions live — your database in production |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | — | Short-circuits **every** check to `true` when it returns `true` (Laravel's `Gate::before`). Not a role: `hasRole()` still answers membership; `isSuperAdmin(user)` asks for the bypass |
| `scope` | `() => string` | `ctx().tenant.id` ?? `GLOBAL_SCOPE` | Current scope; checks consult it plus `GLOBAL_SCOPE` |
| `policies` | `Policy[]` | `[]` | Resource policies registered up front (same as calling `gate.register`) |
| `temporaryGrants` | `TemporaryGrantStore` | off | Enables `grantTemporarily()` |
| `delegations` | `DelegationStore` | off | Enables `delegate()` |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |
| `onMissingPolicy` | `'error' \| 'rbac'` | `'error'` | What `can(user, perm, resource)` does when no policy check matches `resource:action`: `'error'` throws `MissingPolicyError` (fail closed), `'rbac'` falls back to the granted permission strings. Also decides whether a resource requirement without a policy refuses the boot |
| `resourceNotFound` | `'not-found' \| 'deny'` | `'not-found'` | Plugin only. What a [resource requirement](#policies-in-the-guard-resource-requirements) answers when its loader finds nothing: `404 RESOURCE_NOT_FOUND` or an audited `403 PERMISSION_DENIED` |
| `roleCatalog` | `Record<string, string[]>` | — | Code-defined role → permissions valid in every scope; a role grants them only in the scope where it is held. See [One role catalogue for every tenant](#one-role-catalogue-for-every-tenant) |
| `inheritGlobalRolePermissions` | `boolean \| string[]` | `false` | A tenant-held role also resolves its permissions from its `GLOBAL_SCOPE` definition (only in that tenant); a list limits it to those role names |
| `readLegacyGlobalScope` | `boolean` | `false` | Also read rows under the pre-1.5 global scope `'global'` as global. Transition aid — see [The global scope can't be a tenant](#the-global-scope-can-t-be-a-tenant) |
| `hooks` | `HookBus` | the app's bus (plugin) | Where `permission:*` hooks are emitted |
| `allowGlobalWrites` | `boolean` | `false` | Let a scope-less write outside a tenant fall back to `GLOBAL_SCOPE` even when tenancy is active. See [Writes need a tenant](#writes-need-a-tenant-or-an-explicit-scope) |
| `tenancyActive` | `() => boolean` | the `tenancy:active` marker (plugin); `false` (`new Gate`) | Whether the app is multi-tenant — decides whether scope-less writes outside a tenant fail closed |

The plugin registers the Gate under the `GATE` token, adds the `meta.can` guard
and its side-effect-free visibility check (`http:route-visibility`), validates
resource requirements at boot (`http:meta-validators`), and claims the `can`
key in the adapters' boot-time guarded-meta check.

## Hooks — the audit trail

The Gate emits `permission:*` hooks, which `auditPlugin` captures by default:

| Hook | Payload | When |
| --- | --- | --- |
| `permission:denied` | `{ userId, permission, scope }` | `authorize()`, a `meta.can` route or an audience refused the caller |
| `permission:role_assigned` / `permission:role_removed` | `{ userId, role, scope }` | `gate.assignRole()` / `gate.removeRole()` |
| `permission:granted` | `{ role?, userId?, permissions, scope, expiresAt? }` | `gate.grantToRole()`, `gate.grantToUser()`, `gate.grantTemporarily()` |
| `permission:delegated` | `{ fromUserId, toUserId, permissions, scope, expiresAt? }` | `gate.delegate()` |

Change grants through the Gate (`gate.assignRole(userId, role, scope?)`, …) rather
than the store: writes straight on the `AccessStore` leave no trail.

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | The check failed — nothing grants the permission in the current or global scope |
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | A `meta.can` route was hit with no authenticated user in context (or a user without a non-empty string `id`); also `can`/`authorize`/`hasRole` given such a user |
| `ScopeRequiredError` | `PERMISSION_SCOPE_REQUIRED` | 400 | A grant write with no `scope`, no tenant in the context, and tenancy active — pass the scope (or `GLOBAL_SCOPE`) explicitly |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | `meta.can` has an unenforceable shape (`true`, a number, an empty array, a malformed entry) — fails closed on every request |
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | 404 | A resource requirement's loader returned `null`/`undefined` (unless `notFound: 'deny'`) |
| `CanResourceUnavailableError` | `PERMISSION_RESOURCE_UNAVAILABLE` | 500 | `canResource()` called where the guard loaded no resource (or several, without naming the permission) |
| `InvalidRouteMetaError` | `HTTP_INVALID_ROUTE_META` | boot | A resource requirement is malformed, or no policy decides its permission (under `onMissingPolicy: 'error'`) |
| `ReservedScopeError` | `PERMISSION_SCOPE_RESERVED` | 403 | The request's tenant id is a reserved scope (`'@global'` or `'global'`), or the tenant has no usable id |
| `MissingPolicyError` | `PERMISSION_POLICY_MISSING` | 500 | `can`/`authorize` got a resource but no policy check matches `resource:action` — the ABAC rule you intended would be skipped |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.can` (or `auth`/`teamRole`/`scopes`/`subscribed`/`feature`) and no registered guard claims that key |

- **`PERMISSION_DENIED` for a user who "has the role"** — check the *scope*:
  a role assigned in tenant `acme` doesn't apply in `globex` or globally.
  Assign in `GLOBAL_SCOPE` for cross-tenant staff. If the *role* is per tenant
  (teams) but its permissions were granted only in `GLOBAL_SCOPE`, use
  `roleCatalog` or `inheritGlobalRolePermissions` — see
  [One role catalogue for every tenant](#one-role-catalogue-for-every-tenant).
- **`PERMISSION_POLICY_MISSING` after an upgrade** — a `can(user, perm, resource)`
  call was already silently answering from RBAC. Check the spelling of both
  halves of `resource:action` against `definePolicy`, register the missing
  check, or — if that call really is plain RBAC — stop passing the resource.
  `onMissingPolicy: 'rbac'` restores the old behaviour wholesale.
- **A policy check seems ignored** — the policy only runs when a *resource* is
  passed to `can`/`authorize`; `can(user, 'project:update')` with no resource —
  and a plain `meta.can: 'project:update'` — is pure RBAC by design and never
  consults a policy. Declare the resource on the route
  ([Policies in the guard](#policies-in-the-guard-resource-requirements)).
- **`HTTP_UNGUARDED_ROUTE_META` at boot** — register `permissionsPlugin`, or,
  if authorization genuinely happens at an outer edge, opt out explicitly with
  the adapter option `allowUnguardedMeta: true` (or `['can']`). See the
  [adapters guide](/guide/adapters) and the [security guide](/guide/security).
