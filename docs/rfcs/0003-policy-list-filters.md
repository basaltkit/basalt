# RFC 0003 — Policy list filters: the list form of a policy in `@basaltkit/permissions`

- **Status:** Accepted (implemented in this change)
- **Author:** basalt-principal-architect
- **Date:** 2026-10-08
- **Affects:** `@basaltkit/permissions` (minor, 4.0.0 → 4.1.0). `@basaltkit/prisma` is **not** changed.
- **Non-negotiables honoured:** no HTTP surface, so adapter parity (fastify/express/hono) is unaffected; DI and plugin wiring unchanged; fail-closed; authorization stays out of the tenancy primitive; the AI/codegen layer is untouched.

---

## 0. TL;DR

A policy (`definePolicy`) decides about **one loaded object**. Listings need the
**same rule as a predicate** the database applies, or pages come back short and
totals lie. Today the docs recipe is two hand-kept functions — a `...AccessWhere`
helper and the policy check — with nothing linking them.

This RFC adds one optional field and one method:

```ts
const DocumentPolicy = definePolicy<Document, Prisma.DocumentWhereInput>(
  'document',
  { read: (u, d) => d.ownerId === u.id },
  { filters: { read: (u) => ({ ownerId: u.id }) } },
)

const f = await gate.listFilter<Prisma.DocumentWhereInput>(me, 'document:read')
// { kind: 'unrestricted' } | { kind: 'none' } | { kind: 'where', where }
```

It **rejects** an ORM-level row filter (a `rowFilter` on `tenancyExtension()` or
a `prismaPolicy()` Prisma extension) and records why, with a re-open condition.

## 1. Context

**BK-029** (raised from the Mukanda app's backlog) asked for row-level access
filtering in the framework. Looking at the real consumers:

- **Mukanda** (document management). Its access rule (`documentAcl(viewer, alias,
  level)` / `collectionAcl(...)`) is raw `Prisma.Sql`: it references columns on
  both sides (`dc.path like anc.path || '%'`), runs `EXISTS` over grant tables,
  takes a table **alias** and an access **level**, and is composed into
  `$queryRaw` search, suggestions and facets. The app is schema-per-tenant and
  does not use `tenancyExtension`. It does not use `definePolicy`.
- **lexfirma demo** (law firm). Six listings (deadlines, tasks, hearings,
  calendar events, time entries, expense entries) load the firm's rows and
  post-filter them with `gate.can(me, 'matter:read', matter)`. Its own
  `AcessoACasos` doc says why: duplicating the rule in SQL would be "the same
  rule in two places — which diverge", and "when volume demands it, the path is
  for the policy to produce the filter, not to write a second one". Its rule
  includes delegation (`substitui`), `leadLawyerId`, team visibility and an
  undefined-visibility case, and needs an actor hydrated asynchronously from
  the database.
- **lobito** (logistics). RBAC only; no row-level access.

**Motivation, stated honestly.** What this change buys is:

1. **Co-location.** The list rule sits next to its check, in the same
   `definePolicy` call, so a reviewer sees both and a parity test has one place
   to point at.
2. **A fail-closed lookup.** Asking for the list form of a permission that has
   none throws; it never degrades to "all rows".

`superAdmin` parity with `can()` is a **correctness property of the design**,
not an observed bug: neither app configures `superAdmin` today.

Mukanda **can adopt, not required to**: its `level` maps to separate actions
(`read`, `edit`, `manage`), its alias maps to `TWhere = (alias: string) =>
Prisma.Sql`, and it would first need to adopt `definePolicy`.

## 2. Rejected

### 2.1 An ORM-level row filter (`rowFilter` on `tenancyExtension`, `prismaPolicy`)

1. **Relation leaks.** `scopeWhere` (`packages/prisma/src/extension.ts`) is safe
   at the top level only because every relation stays inside one tenant. An
   access predicate is not relation-closed:
   `matter.findUnique({ include: { deadlines: true } })` bypasses a `Deadline`
   filter, as do `select: { _count: … }` and relation filters
   (`some`/`every`/`none`) in other models' `where`. A to-one include of a
   filtered model cannot be filtered in Prisma at all. Closing these holes means
   walking the DMMF over every `include`/`select` and refusing to-one reads —
   large, fragile and tied to the Prisma version. Leaving them open fails open.
2. **It does not serve raw SQL.** The original requester's rule is `Prisma.Sql`
   with an alias and a level, composed into `$queryRaw`; a model-query
   extension protects none of its listings.
3. **Async actor re-entering the client.** Roles, teams and delegations come
   from the database; hydrating them inside a `$allOperations` hook re-enters
   the same extended client and needs a bypass channel — a new escape hatch.
4. **Read/write and actorless semantics.** Which predicate applies to an
   `update`? What happens in a job with no actor — fail closed (breaks every
   job) or bypass (unsafe)?
5. **Authorization inside tenancy.** It mixes product authorization into the
   tenancy primitive, which an earlier review already rejected.

**Re-open condition:** two apps on `tenancyExtension` whose rule is a pure
Prisma `where`, with no raw-SQL listings, and that accept the
include/`_count` gap.

Teams that want ambient in-tenant enforcement can write Postgres row-level
security policies in their own migrations; no framework API is needed.

### 2.2 Docs only

Keeps two unlinked functions and no fail-closed lookup — the divergence the demo
cites as its reason to post-filter.

## 3. Decision

```ts
export type PolicyFilter<TWhere = unknown> =
  (user: PolicyUser) => TWhere | boolean | Promise<TWhere | boolean>

export interface PolicyOptions<TWhere = unknown> {
  filters?: Record<string, PolicyFilter<TWhere>>   // every key must be a key of `checks`
}

export interface Policy<TResource = unknown, TWhere = unknown> {
  resource: string
  checks: Record<string, PolicyCheck<TResource>>
  filters?: Record<string, PolicyFilter<TWhere>>   // new, optional
}

export function definePolicy<TResource, TWhere = unknown>(
  resource: string, checks: Record<string, PolicyCheck<TResource>>, options?: PolicyOptions<TWhere>,
): Policy<TResource, TWhere>

export type ListFilter<TWhere = unknown> =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'none' }
  | { readonly kind: 'where'; readonly where: TWhere }

class Gate {
  listFilter<TWhere = unknown>(user: PolicyUser, permission: string): Promise<ListFilter<TWhere>>
}

export class MissingPolicyFilterError extends BasaltError {} // PERMISSION_FILTER_MISSING, 500
```

`gate.listFilter(user, permission)`, in order:

1. A user without a non-empty string `id` → `AuthRequiredGuardError`. A
   malformed permission → `TypeError`.
2. `superAdmin(user)` true → `unrestricted`, without calling the filter (as
   `can()` short-circuits).
3. The filter for exactly `resource:action` (two segments, own entries only,
   prototype-free snapshot). None → `MissingPolicyFilterError`, **always** —
   `onMissingPolicy` does not apply and RBAC is never consulted.
4. Result: literal `true` → `unrestricted`; literal `false` → `none`;
   `null`/`undefined` → `TypeError`; anything else → `{ kind: 'where', where }`
   verbatim.
5. The policy decides alone, as `can(user, p, resource)` does: RBAC and Gate
   delegation are not consulted. App-hydrated actor fields (`teamIds`,
   `delegatedFrom`) reach the filter through `user`. The route's `meta.can`
   still gates the endpoint.
6. Side-effect free: no hooks, no denial record, no writes.

`definePolicy` and `Gate.register` both validate and snapshot `filters`: a
non-null object of functions, every key an own key of `checks`.

`TWhere` on `listFilter<TWhere>()` is a **caller-side type assertion**: policies
are stored by resource name, so it is not linked to the `TWhere` the policy was
defined with.

## 4. Security

- **Fail closed:** a missing filter throws, never `unrestricted`.
- **Literal `true` only** means unrestricted; `null`/`undefined` throws (a
  forgotten `return` is a bug, not "all rows").
- **Prototype-free lookup:** `document:constructor`, `document:__proto__`,
  `document:toString` are missing filters, not `Object`.
- **Two segments:** `document:read:x` is not `document:read`.
- **Pairing:** a filter requires a check of the same action.
- **`superAdmin` parity** with `can()`.
- **`unrestricted` is not a tenant bypass.** It means no access narrowing within
  whatever tenant isolation the data layer already applies; the filter never
  carries tenant isolation.

**Residual risks** (documented, not solved): a caller can forget to call
`listFilter` — the cost of explicit over ambient; the app's own
`include`/`_count`/relation filters must apply the filter themselves.

## 5. Alternatives considered

- **A separate `defineScope` registry** — rejected: co-location is the point.
- **A where-combine helper** — rejected: a two-line ternary.
- **Naming it `scope`** — rejected: `Gate` already has a private `scope`, and
  "scope" already means the tenant scope and the delegation scope in this
  package; an authorization API must not read like a tenant question.
- **A typed overload taking the policy object** (`gate.listFilter(user,
  DocumentPolicy, 'read')`, inferring `TWhere`) — deferred; additive later.
- **`hasFilter()`, a `/testing` parity helper, an in-package where-matcher** —
  no consumer; the parity check is a docs recipe against the app's real DB.

## 6. Rollout

Minor bump of `@basaltkit/permissions` (4.0.0 → 4.1.0); `Policy` only gains an
optional field. No other package changes. App migrations — replacing the demo's
post-filter, optionally moving Mukanda's ACL into `filters.read` — are the app
owners' follow-ups in their own repositories.
