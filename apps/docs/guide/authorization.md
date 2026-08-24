# Authorization (permissions)

Authentication tells you *who* a user is; [`@basaltkit/permissions`](/reference/packages/permissions)
decides *what* they can do. It centralizes those decisions in one **Gate** you ask
"can this user do `projects:delete`?" — with roles, wildcard permissions and
resource policies, all **tenant-scoped** by default.

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

Wildcards compose: `projects:*` covers every project action, `*` covers everything
(a super admin). `gate.authorize(user, perm)` is the throwing variant — it raises a
403-style error instead of returning `false`.

## Resource policies

For rules that depend on the *specific* resource — "only the project owner can edit
it" — register a policy:

```ts
import { definePolicy } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>({
  name: 'projects:edit',
  check: (user, project) => project.ownerId === user.id,
})

gate.register(ProjectPolicy)
await gate.can({ id: 'u1' }, 'projects:edit', project) // runs the policy with the resource
```

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

## Tenant scoping

Grants are **per tenant** by default: `projects:*` granted in `acme` doesn't apply in
`globex`. Use `GLOBAL_SCOPE` for grants that apply everywhere. There's also
[temporary grants and delegation](/reference/packages/permissions) — a user can lend a
subset of their own direct permissions to another for a bounded time. In production,
swap `MemoryAccessStore` for a durable `AccessStore` (Prisma/SQLite variants ship in
the ecosystem).
