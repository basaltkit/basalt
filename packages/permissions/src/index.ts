import { createToken, definePlugin, ensureMetadata, tryCtx, type BasaltHooks, type Container, type HookBus } from '@basaltkit/core'
import {
  newDelegationId,
  type TemporaryGrant,
  type TemporaryGrantStore,
  type Delegation,
  type DelegationStore,
} from './delegation.js'
import {
  RequestValidationError,
  rawBodyOptionsOf,
  route,
  uploadOptionsOf,
  type BasaltRoute,
  type HttpRequest,
  type RouteGuard,
  type RouteMetaValidator,
  type RouteVisibilityCheck,
  type ValidationIssue,
} from '@basaltkit/http'
import {
  AuthRequiredGuardError,
  CanResourceUnavailableError,
  InvalidCanMetaError,
  MissingPolicyError,
  MissingPolicyFilterError,
  ReservedScopeError,
  ResourceNotFoundError,
  ScopeRequiredError,
} from './errors.js'

export {
  AuthRequiredGuardError,
  CanResourceUnavailableError,
  InvalidCanMetaError,
  MissingPolicyError,
  MissingPolicyFilterError,
  PermissionDeniedError,
  ReservedScopeError,
  ResourceNotFoundError,
  ScopeRequiredError,
} from './errors.js'
import { PermissionDeniedError } from './errors.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    /** A permission check refused the caller (`authorize()`, `meta.can`, audiences). */
    'permission:denied': { userId: string; permission: string; scope: string }
    /** `gate.assignRole()` gave a user a role. */
    'permission:role_assigned': { userId: string; role: string; scope: string }
    /** `gate.removeRole()` took a role away. */
    'permission:role_removed': { userId: string; role: string; scope: string }
    /** Permissions were granted — to a role (`role`) or directly to a user (`userId`). */
    'permission:granted': {
      role?: string
      userId?: string
      permissions: string[]
      scope: string
      /** Set for time-boxed grants (`grantTemporarily()`). */
      expiresAt?: number
    }
    /** `gate.delegate()` let one user act with a subset of another's authority. */
    'permission:delegated': { fromUserId: string; toUserId: string; permissions: string[]; scope: string; expiresAt?: number }
  }
}

declare module '@basaltkit/http' {
  interface RouteMeta {
    /**
     * Permission(s) the caller must hold. Enforced by `permissionsPlugin`.
     *
     * - `'projects:read'` — an RBAC permission;
     * - `{ permission: 'projects:update', resource: (input) => load(input.params.id) }`
     *   — the guard loads the resource and the registered policy decides
     *   (`gate.authorize(user, permission, resource)`); the handler reads it
     *   back with {@link canResource};
     * - an array of either — ALL of them are required.
     */
    can?: CanMeta
    /**
     * Which surface this route belongs to — `'portal'`, `'public'`, whatever
     * the application calls them. Enforced by `permissionsPlugin` when
     * `audiences` is configured.
     *
     * A permission is a capability, not a surface: `matter:read` cannot tell
     * "read my own case in the portal" from "read the case with the litigation
     * strategy in it". This says which one a route is.
     */
    audience?: string
  }
}

/**
 * A set of roles confined to a set of surfaces.
 *
 * ```ts
 * audiences: { portal: { roles: ['client'], allow: ['portal', 'public'] } }
 * ```
 */
export interface AudienceRule {
  /** Roles this rule confines. */
  roles: string[]
  /** The `meta.audience` values those roles may reach. */
  allow: string[]
}


/**
 * Global scope key — role/permission grants that apply in every tenant.
 *
 * Deliberately NOT a value a tenant id can take (no slug, hostname label, uuid
 * or cuid contains '@'): grants are keyed by the tenant id, so a global scope
 * spelt like a tenant id lets whoever owns a tenant with that id write
 * platform-wide grants. The Gate also refuses to evaluate a tenant whose id is
 * a reserved scope ({@link ReservedScopeError}).
 */
export const GLOBAL_SCOPE = '@global'

/**
 * The historic value of {@link GLOBAL_SCOPE} (≤ 1.4). Rows stored under it are
 * NOT read as global unless the Gate is built with `readLegacyGlobalScope:
 * true` — migrate them (`UPDATE … SET scope = '@global' WHERE scope = 'global'`)
 * instead. A tenant whose id is `'global'` is always refused.
 */
export const LEGACY_GLOBAL_SCOPE = 'global'

const RESERVED_SCOPES: ReadonlySet<string> = new Set([GLOBAL_SCOPE, LEGACY_GLOBAL_SCOPE])

/**
 * True when `id` is a scope the Gate reserves for global grants. Tenant
 * registries (and anything that mirrors grants under a tenant id, like teams)
 * should refuse such ids.
 */
export function isReservedScope(id: string): boolean {
  return RESERVED_SCOPES.has(id)
}

/**
 * The permission scope of the current request: the tenant id, or
 * {@link GLOBAL_SCOPE} outside a tenant. Throws {@link ReservedScopeError} when
 * the tenant id is itself a reserved scope.
 */
export function currentScope(): string {
  const tenant: unknown = tryCtx()?.['tenant']
  // No tenant at all is the central scope. A tenant that IS there but carries
  // no usable id is a broken context, not a central request: falling back to
  // GLOBAL_SCOPE would evaluate — and let default-scoped writes land in — the
  // platform-wide bucket.
  if (tenant === undefined || tenant === null) return GLOBAL_SCOPE
  const id = typeof tenant === 'object' ? (tenant as { id?: unknown }).id : undefined
  if (typeof id !== 'string' || id.length === 0) throw new ReservedScopeError('')
  if (isReservedScope(id)) throw new ReservedScopeError(id)
  return id
}

/**
 * Where grants live — the app's database in production. `scope` is the
 * tenant id or GLOBAL_SCOPE, making every grant tenant-scoped by default.
 */
export interface AccessStore {
  getUserRoles(userId: string, scope: string): Promise<string[]>
  getUserPermissions(userId: string, scope: string): Promise<string[]>
  getRolePermissions(role: string, scope: string): Promise<string[]>
  assignRole(userId: string, role: string, scope: string): Promise<void>
  removeRole(userId: string, role: string, scope: string): Promise<void>
  grantToRole(role: string, permissions: string[], scope: string): Promise<void>
  grantToUser(userId: string, permissions: string[], scope: string): Promise<void>
}

/**
 * A user id the Gate can key grants by: a non-empty string. `undefined` and
 * `null` both serialize to the same store key, so a grant written for a
 * missing id would be honoured for every other caller with a missing id.
 */
function isUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function assertUserId(value: unknown, operation: string): asserts value is string {
  if (!isUserId(value)) {
    throw new TypeError(`${operation}: userId must be a non-empty string, received ${describeValue(value)}`)
  }
}

/** A user object the Gate can check: a non-empty string `id`. Anything else is unauthenticated. */
function isPolicyUser(value: unknown): value is PolicyUser {
  return typeof value === 'object' && value !== null && isUserId((value as { id?: unknown }).id)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'an empty string'
  return typeof value
}

// Whitespace and control characters: nothing a permission name legitimately
// carries, and a sign the string was built from unchecked input.
const INVALID_PERMISSION = /[\s\p{Cc}]/u

/**
 * A permission the Gate accepts: a non-empty string without whitespace or
 * control characters, and no empty `:` segment (`'projects:'`, `':read'`,
 * `'a::b'`) — those never match anything, so checking or granting one is a bug.
 */
function isValidPermission(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !INVALID_PERMISSION.test(value) && !hasEmptySegment(value)
}

function assertPermission(value: unknown, operation: string): asserts value is string {
  if (!isValidPermission(value)) {
    throw new TypeError(
      `${operation}: a permission must be a non-empty string without whitespace, control characters or empty ":" segments`,
    )
  }
}

function assertPermissions(value: unknown, operation: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${operation}: permissions must be an array of strings`)
  for (const permission of value as unknown[]) assertPermission(permission, operation)
}

function assertScope(value: unknown, operation: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${operation}: scope must be a non-empty string`)
  }
}

export class MemoryAccessStore implements AccessStore {
  private readonly userRoles = new Map<string, Set<string>>()
  private readonly userPermissions = new Map<string, Set<string>>()
  private readonly rolePermissions = new Map<string, Set<string>>()

  // JSON-encoded tuple, not `${scope}::${id}`: a separator that ids may contain
  // makes ('a::b', 'c') and ('a', 'b::c') the same key.
  private key(a: string, scope: string): string {
    return JSON.stringify([scope, a])
  }

  async getUserRoles(userId: string, scope: string): Promise<string[]> {
    return [...(this.userRoles.get(this.key(userId, scope)) ?? [])]
  }

  async getUserPermissions(userId: string, scope: string): Promise<string[]> {
    return [...(this.userPermissions.get(this.key(userId, scope)) ?? [])]
  }

  async getRolePermissions(role: string, scope: string): Promise<string[]> {
    return [...(this.rolePermissions.get(this.key(role, scope)) ?? [])]
  }

  async assignRole(userId: string, role: string, scope: string): Promise<void> {
    assertUserId(userId, 'assignRole')
    assertRole(role, 'assignRole')
    const key = this.key(userId, scope)
    const roles = this.userRoles.get(key) ?? new Set()
    roles.add(role)
    this.userRoles.set(key, roles)
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    this.userRoles.get(this.key(userId, scope))?.delete(role)
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    assertRole(role, 'grantToRole')
    const key = this.key(role, scope)
    const set = this.rolePermissions.get(key) ?? new Set()
    for (const permission of permissions) set.add(permission)
    this.rolePermissions.set(key, set)
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
    assertUserId(userId, 'grantToUser')
    const key = this.key(userId, scope)
    const set = this.userPermissions.get(key) ?? new Set()
    for (const permission of permissions) set.add(permission)
    this.userPermissions.set(key, set)
  }
}

// The rule itself lives in `./match.js`, which imports nothing — so it can also
// be reached from a browser through the `@basaltkit/permissions/match` subpath.
// Imported (not just re-exported) because this module uses it too: a bare
// `export … from` re-exports the name without binding it locally, and the two
// call sites below would fail at runtime with "permissionMatches is not
// defined" — which is exactly what happened.
export { hasEmptySegment, permissionMatches, permitted } from './match.js'
import { hasEmptySegment, permissionMatches } from './match.js'

export interface PolicyUser {
  id: string
  [key: string]: unknown
}

export type PolicyCheck<TResource = unknown> = (
  user: PolicyUser,
  resource: TResource,
) => boolean | Promise<boolean>

/**
 * The list form of a check: the predicate the data layer applies to list and
 * count queries. Return `true` for "no access narrowing", `false` for "no
 * rows", or the predicate itself (a Prisma `where`, a `Prisma.Sql` fragment, a
 * function of a table alias — whatever the app's data layer composes).
 */
export type PolicyFilter<TWhere = unknown> = (user: PolicyUser) => TWhere | boolean | Promise<TWhere | boolean>

export interface PolicyOptions<TWhere = unknown> {
  /**
   * List form of the checks: action → the predicate the data layer applies to
   * list/count queries ({@link Gate.listFilter}). Every key must also be a key
   * of `checks` — a list rule never exists without its single-object rule.
   */
  filters?: Record<string, PolicyFilter<TWhere>>
}

export interface Policy<TResource = unknown, TWhere = unknown> {
  resource: string
  checks: Record<string, PolicyCheck<TResource>>
  /** List form of the checks — see {@link PolicyOptions.filters}. */
  filters?: Record<string, PolicyFilter<TWhere>>
}

/**
 * What {@link Gate.listFilter} answers. `unrestricted` means no access
 * narrowing within whatever tenant isolation the data layer already applies —
 * the filter never carries tenant isolation.
 */
export type ListFilter<TWhere = unknown> =
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'none' }
  | { readonly kind: 'where'; readonly where: TWhere }

/**
 * Contextual (ABAC) rules for a resource type:
 *
 * const ProjectPolicy = definePolicy('project', {
 *   update: (user, project) => project.ownerId === user.id,
 * })
 *
 * With `filters`, the same rules in list form, for {@link Gate.listFilter}:
 *
 * definePolicy<Project, Prisma.ProjectWhereInput>('project',
 *   { read: (user, project) => project.ownerId === user.id },
 *   { filters: { read: (user) => ({ ownerId: user.id }) } },
 * )
 */
export function definePolicy<TResource, TWhere = unknown>(
  resource: string,
  checks: Record<string, PolicyCheck<TResource>>,
  options?: PolicyOptions<TWhere>,
): Policy<TResource, TWhere> {
  const snapshot = snapshotChecks<TResource>(resource, checks)
  const filters = snapshotFilters<TWhere>(resource, snapshot, options?.filters)
  return filters ? { resource, checks: snapshot, filters } : { resource, checks: snapshot }
}

/**
 * The checks as a prototype-free lookup of their OWN entries. A plain object
 * literal inherits `constructor`, `toString`, `hasOwnProperty`…: looked up by
 * an action name taken from the permission string, `checks['constructor']` is
 * `Object` — a function returning a truthy value — and would authorize anyone.
 */
function snapshotChecks<TResource>(
  resource: unknown,
  checks: unknown,
): Record<string, PolicyCheck<TResource>> {
  if (typeof resource !== 'string' || resource.length === 0 || resource.includes(':')) {
    throw new TypeError('definePolicy: resource must be a non-empty string without ":"')
  }
  if (typeof checks !== 'object' || checks === null) {
    throw new TypeError(`definePolicy(${resource}): checks must be an object of action → check`)
  }
  const snapshot = Object.create(null) as Record<string, PolicyCheck<TResource>>
  for (const [action, check] of Object.entries(checks)) {
    if (typeof check !== 'function') {
      throw new TypeError(`definePolicy(${resource}): check "${action}" must be a function`)
    }
    snapshot[action] = check as PolicyCheck<TResource>
  }
  return snapshot
}

/**
 * The filters as a prototype-free lookup of their OWN entries, for the same
 * reason as {@link snapshotChecks}. `undefined` when there are none. Every
 * filter must pair with a check of the same action.
 */
function snapshotFilters<TWhere>(
  resource: string,
  checks: Record<string, unknown>,
  filters: unknown,
): Record<string, PolicyFilter<TWhere>> | undefined {
  if (filters === undefined) return undefined
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new TypeError(`definePolicy(${resource}): filters must be an object of action → filter`)
  }
  const snapshot = Object.create(null) as Record<string, PolicyFilter<TWhere>>
  for (const [action, filter] of Object.entries(filters)) {
    if (typeof filter !== 'function') {
      throw new TypeError(`definePolicy(${resource}): filter "${action}" must be a function`)
    }
    if (!Object.hasOwn(checks, action)) {
      throw new TypeError(`definePolicy(${resource}): filter "${action}" has no matching check`)
    }
    snapshot[action] = filter as PolicyFilter<TWhere>
  }
  return snapshot
}

export interface GateOptions {
  store: AccessStore
  /**
   * Short-circuits every check — Laravel's Gate::before. Also consulted when a
   * listing (`tools/list`) asks which `meta.can` routes a caller could pass, so
   * keep it free of side effects.
   */
  superAdmin?: (user: PolicyUser) => boolean | Promise<boolean>
  /** Current scope. Default: ctx().tenant.id, falling back to GLOBAL_SCOPE. */
  scope?: () => string
  policies?: Policy<never>[]
  /** Optional store enabling time-boxed grants via `grantTemporarily()`. */
  temporaryGrants?: TemporaryGrantStore
  /** Optional store enabling `delegate()` — one user acting with another's authority. */
  delegations?: DelegationStore
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
  /**
   * What to do when `can()` is given a resource but no policy check matches
   * `resource:action`. `'error'` (default) throws {@link MissingPolicyError} —
   * passing a resource is an explicit ABAC intent, and silently answering from
   * RBAC means the ownership rule never runs. `'rbac'` restores the historic
   * fall-through for apps that pass resources opportunistically.
   */
  onMissingPolicy?: 'error' | 'rbac'
  /**
   * Also read grants stored under the historic global scope `'global'`
   * ({@link LEGACY_GLOBAL_SCOPE}) as global. Default `false`. A transition aid
   * only: while it is on, anything that writes grants under a tenant id of
   * `'global'` (e.g. teams mirroring a membership) writes global grants — so
   * reserve that tenant id in your tenant registry, then migrate the rows to
   * {@link GLOBAL_SCOPE} and turn this off.
   */
  readLegacyGlobalScope?: boolean
  /**
   * Hook bus to emit `permission:*` events on (denials, role and grant
   * changes) — `permissionsPlugin` wires the app's bus, which `auditPlugin`
   * captures by default.
   */
  hooks?: HookBus
  /**
   * Code-defined role → permissions catalogue, valid in **every** scope:
   * a role held in a scope grants its catalogue permissions in that scope
   * (never elsewhere), in addition to whatever the store grants the role there.
   *
   * ```ts
   * roleCatalog: { owner: ['*'], admin: ['projects:*', 'members:invite'], member: ['projects:read'] }
   * ```
   *
   * Pairs with `@basaltkit/teams`, which assigns roles per tenant
   * (`assignRole(user, role, tenantId)`): the tenant owner gets `'*'` in their
   * tenant without copying the catalogue into every tenant. Snapshotted at
   * construction; malformed entries throw a `TypeError`.
   */
  roleCatalog?: Readonly<Record<string, readonly string[]>>
  /**
   * Resolve a tenant-held role's permissions from its **global** definition
   * (`grantToRole(role, perms, GLOBAL_SCOPE)`) too — still granting only in
   * the tenant where the role is held. Default `false` (the historic
   * same-scope lookup).
   *
   * `true` applies to every role name; a list restricts it to those names.
   * Prefer the list whenever tenants can assign roles themselves: with `true`,
   * a tenant admin who can assign an arbitrary role name (say, a global
   * `platform-admin`) gets that role's global permission set inside their
   * tenant.
   */
  inheritGlobalRolePermissions?: boolean | readonly string[]
  /**
   * Let a write with no explicit `scope` land in {@link GLOBAL_SCOPE} when no
   * tenant is in the context, even though tenancy is active. Default `false`:
   * in a multi-tenant app such a write throws {@link ScopeRequiredError}
   * instead — an unresolved tenant must not turn a tenant-admin call into a
   * platform-wide grant. Passing `GLOBAL_SCOPE` explicitly always works.
   * Single-tenant apps (no tenancy) are unaffected either way.
   */
  allowGlobalWrites?: boolean
  /**
   * Whether the app is multi-tenant. `permissionsPlugin` wires this to the
   * `'tenancy:active'` marker `tenancyPlugin` registers; a Gate built by hand
   * defaults to `false` (single-tenant). Only decides whether a scope-less
   * write outside a tenant fails closed (see `allowGlobalWrites`).
   */
  tenancyActive?: () => boolean
}

/** Validates and deep-copies a role catalogue into a prototype-free lookup. */
function snapshotRoleCatalog(
  catalog: Readonly<Record<string, readonly string[]>> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const snapshot = new Map<string, readonly string[]>()
  if (catalog === undefined) return snapshot
  if (catalog === null || typeof catalog !== 'object') throw new TypeError('roleCatalog must be an object of role → permission[]')
  for (const [role, permissions] of Object.entries(catalog)) {
    if (role.length === 0) throw new TypeError('roleCatalog: role names must be non-empty strings')
    if (!Array.isArray(permissions)) throw new TypeError(`roleCatalog.${role} must be an array of permissions`)
    for (const permission of permissions as unknown[]) {
      if (!isValidPermission(permission)) {
        throw new TypeError(
          `roleCatalog.${role} must contain only well-formed permissions (non-empty, no whitespace, no empty ":" segments)`,
        )
      }
    }
    snapshot.set(role, Object.freeze([...permissions]))
  }
  return snapshot
}

const defaultScope = currentScope

type PermissionHook =
  | 'permission:denied'
  | 'permission:role_assigned'
  | 'permission:role_removed'
  | 'permission:granted'
  | 'permission:delegated'

export class Gate {
  /** The grants this gate reads. Exposed for `accessRoutes()`; treat as read-only. */
  get store(): AccessStore {
    return this.options.store
  }

  private readonly policies = new Map<string, Policy<never>>()
  private readonly scope: () => string
  private readonly now: () => number
  private readonly roleCatalog: ReadonlyMap<string, readonly string[]>
  private readonly inheritGlobal: (role: string) => boolean

  constructor(private readonly options: GateOptions) {
    this.scope = options.scope ?? defaultScope
    this.now = options.now ?? (() => Date.now())
    this.roleCatalog = snapshotRoleCatalog(options.roleCatalog)
    const inherit = options.inheritGlobalRolePermissions
    if (Array.isArray(inherit)) {
      const names = new Set<string>(inherit)
      this.inheritGlobal = (role) => names.has(role)
    } else {
      const all = inherit === true
      this.inheritGlobal = () => all
    }
    for (const policy of options.policies ?? []) this.register(policy)
  }

  register(policy: Policy<never>): this {
    // Snapshotted here too: a Policy is a public shape, and one built by hand
    // (not through definePolicy) must not bring its prototype into the lookup.
    const checks = snapshotChecks<never>(policy.resource, policy.checks)
    const filters = snapshotFilters<unknown>(policy.resource, checks, policy.filters)
    this.policies.set(policy.resource, filters ? { resource: policy.resource, checks, filters } : { resource: policy.resource, checks })
    return this
  }

  /**
   * The user of the current request, with its roles attached.
   *
   * What `@basaltkit/auth` puts in the context is `PublicUser` —
   * `{ id, email, emailVerified }`. No roles, and rightly so: `auth` does not
   * know this package exists.
   *
   * But policies receive that object, and `PolicyUser` is open, so
   * `user.roles?.includes('partner')` reads `undefined` and the policy denies.
   * The right failure mode, and an invisible one — a partner treated as a
   * stranger in their own firm, with no error anywhere to say why.
   *
   * Nothing filled the gap, so every service wrote this by hand and memoised it
   * under a private context key it had to invent. Here it is once, memoised per
   * request and per scope, because the same person can hold different roles in
   * two tenants.
   *
   * `null` when there is no user — a background job, a public route. An object
   * with an empty id would be an actor that fails every check for a reason
   * nobody can read.
   */
  async actor(): Promise<PolicyUser | null> {
    const context = tryCtx()
    const user = context?.['user'] as { id: string } | undefined
    if (!isPolicyUser(user)) return null

    const scope = this.scope()
    // Keyed by user AND scope: caching by user alone would carry one tenant's
    // roles into a request for another.
    const key = `__basaltGateActor:${scope}:${user.id}`
    const cached = context?.[key] as PolicyUser | undefined
    if (cached) return cached

    const roles = await this.options.store.getUserRoles(user.id, scope)
    const actor: PolicyUser = { ...user, roles }
    if (context) (context as Record<string, unknown>)[key] = actor
    return actor
  }

  /**
   * Permission check. With a resource, a matching policy ('resource:action')
   * decides; otherwise the granted permission strings (with wildcards) do.
   * Grants are looked up in the current scope AND the global scope.
   *
   * Side-effect free: store and grant reads plus the `superAdmin` callback
   * (keep it pure), never a hook, a denial record or a write — `authorize()`
   * is what emits `permission:denied`. The plugin's `http:route-visibility`
   * check relies on this to answer listings without auditing them.
   */
  async can(user: PolicyUser, permission: string, resource?: unknown): Promise<boolean> {
    // No usable id is no user: `undefined` and `null` ids share one store key,
    // so answering for them would honour whatever was granted to "nobody".
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    assertPermission(permission, 'can')
    if (await this.options.superAdmin?.(user)) return true

    if (resource !== undefined) {
      const check = this.policyCheck(permission)
      // Strictly `true`: a check returning a truthy non-boolean is a bug, not a grant.
      if (check) return (await check(user, resource as never)) === true
      // A resource was passed, so ABAC was intended. Falling through to RBAC here
      // silently drops the ownership check — fail closed unless opted out.
      if ((this.options.onMissingPolicy ?? 'error') === 'error') {
        throw new MissingPolicyError(permission, [...this.policies.keys()])
      }
    }

    if (await this.canDirect(user.id, permission)) return true
    if (await this.canViaDelegation(user.id, permission)) return true
    return false
  }

  /**
   * The list form of `can(user, permission, resource)`: the predicate a
   * repository applies to list and count queries, from the registered policy's
   * `filters` (see {@link definePolicy}).
   *
   * ```ts
   * const f = await gate.listFilter<Prisma.DocumentWhereInput>(me, 'document:read')
   * if (f.kind === 'none') return { rows: [], total: 0 }
   * const where = f.kind === 'unrestricted' ? filter : { AND: [f.where, filter] }
   * ```
   *
   * - `superAdmin` short-circuits to `unrestricted`, as in `can()`.
   * - No filter for exactly `resource:action` throws
   *   {@link MissingPolicyFilterError} — whatever `onMissingPolicy` says. There
   *   is no RBAC fallback: "RBAC allows" has no row-set meaning.
   * - The policy decides alone: RBAC grants and Gate delegations are not
   *   consulted (the route's `meta.can` still gates the endpoint).
   * - A filter returning literal `true` is `unrestricted`, `false` is `none`,
   *   `null`/`undefined` throws a `TypeError`, anything else is returned
   *   verbatim as `where`.
   * - Side-effect free, like `can()`.
   *
   * `TWhere` is a caller-side type ASSERTION: it is not linked to the `TWhere`
   * the policy was defined with.
   */
  async listFilter<TWhere = unknown>(user: PolicyUser, permission: string): Promise<ListFilter<TWhere>> {
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    assertPermission(permission, 'listFilter')
    if (await this.options.superAdmin?.(user)) return { kind: 'unrestricted' }

    const filter = this.policyFilter(permission)
    if (!filter) throw new MissingPolicyFilterError(permission, this.registeredFilters())
    const result: unknown = await filter(user)
    if (result === true) return { kind: 'unrestricted' }
    if (result === false) return { kind: 'none' }
    if (result === undefined || result === null) {
      throw new TypeError(
        `listFilter(${permission}): the filter returned ${String(result)} — return true (unrestricted), ` +
          `false (none) or the predicate`,
      )
    }
    return { kind: 'where', where: result as TWhere }
  }

  /** The filter for exactly `resource:action` — the same lookup rules as {@link policyCheck}. */
  private policyFilter(permission: string): PolicyFilter<unknown> | undefined {
    const segments = permission.split(':')
    if (segments.length !== 2) return undefined
    const [resourceName, action] = segments as [string, string]
    const filters = this.policies.get(resourceName)?.filters
    if (!filters || !Object.hasOwn(filters, action)) return undefined
    const filter = filters[action]
    return typeof filter === 'function' ? filter : undefined
  }

  private registeredFilters(): string[] {
    const out: string[] = []
    for (const [resourceName, policy] of this.policies) {
      for (const action of Object.keys(policy.filters ?? {})) out.push(`${resourceName}:${action}`)
    }
    return out
  }

  /**
   * True when a registered policy check decides exactly `permission`
   * (`resource:action`) — i.e. when `can(user, permission, resource)` would
   * consult a policy instead of throwing {@link MissingPolicyError} (or falling
   * back to RBAC under `onMissingPolicy: 'rbac'`). A pure lookup.
   */
  hasPolicy(permission: string): boolean {
    return isValidPermission(permission) && this.policyCheck(permission) !== undefined
  }

  /**
   * The policy check for exactly `resource:action`. Own entries only (see
   * {@link snapshotChecks}), and only for two segments: `project:update:billing`
   * is a different permission from `project:update`, so the `update` check must
   * not decide it — that is a missing policy, not a match.
   */
  private policyCheck(permission: string): PolicyCheck<never> | undefined {
    const segments = permission.split(':')
    if (segments.length !== 2) return undefined
    const [resourceName, action] = segments as [string, string]
    const policy = this.policies.get(resourceName)
    if (!policy || !Object.hasOwn(policy.checks, action)) return undefined
    const check = policy.checks[action]
    return typeof check === 'function' ? check : undefined
  }

  /**
   * The scope a write lands in. An explicit scope always wins (including
   * `GLOBAL_SCOPE`), as does a custom `scope` option. Otherwise the current
   * tenant — and when there is none in a multi-tenant app, the write fails
   * closed rather than defaulting to the platform-wide bucket.
   */
  private writeScope(explicit: string | undefined, operation: string): string {
    if (explicit !== undefined) {
      assertScope(explicit, operation)
      return explicit
    }
    if (this.options.scope) return this.options.scope()
    const scope = currentScope()
    if (scope === GLOBAL_SCOPE && !this.options.allowGlobalWrites && this.tenancyActive()) {
      throw new ScopeRequiredError(operation)
    }
    return scope
  }

  private tenancyActive(): boolean {
    return this.options.tenancyActive?.() === true
  }

  private scopes(): string[] {
    const scopes = [this.scope(), GLOBAL_SCOPE]
    if (this.options.readLegacyGlobalScope) scopes.push(LEGACY_GLOBAL_SCOPE)
    return scopes.filter((scope, index, all) => all.indexOf(scope) === index)
  }

  /** The union of the user's roles over every scope a check consults. */
  async effectiveRoles(userId: string): Promise<string[]> {
    assertUserId(userId, 'effectiveRoles')
    const roles = new Set<string>()
    for (const scope of this.scopes()) {
      for (const role of await this.options.store.getUserRoles(userId, scope)) roles.add(role)
    }
    return [...roles]
  }

  /**
   * The roles the audience guard confines on. Inside a tenant, the roles held
   * IN that tenant decide; the global (and legacy) roles decide only when the
   * tenant grants none. Not the {@link effectiveRoles} union: one unnamed
   * global role (a baseline `user` every signup gets) would otherwise count as
   * "something else" and un-confine a tenant's portal client in every tenant.
   * A confined role assigned globally still confines wherever the user holds
   * no tenant role, and a tenant role that no rule names still un-confines.
   */
  async audienceRoles(userId: string): Promise<string[]> {
    assertUserId(userId, 'audienceRoles')
    const [current, ...fallback] = this.scopes()
    const own = await this.options.store.getUserRoles(userId, current!)
    if (own.length > 0) return [...new Set(own)]
    const roles = new Set<string>()
    for (const scope of fallback) {
      for (const role of await this.options.store.getUserRoles(userId, scope)) roles.add(role)
    }
    return [...roles]
  }

  private async emit<K extends PermissionHook>(hook: K, payload: BasaltHooks[K]): Promise<void> {
    await this.options.hooks?.emit(hook, payload)
  }

  /**
   * Emits `permission:denied` and returns the error to throw. Every refusal
   * the package makes goes through here, so the audit trail sees them all.
   */
  async denied(userId: string, permission: string): Promise<PermissionDeniedError> {
    await this.emit('permission:denied', { userId, permission, scope: this.scope() })
    return new PermissionDeniedError(permission)
  }

  /** Gives `userId` a role in `scope` (default: the current scope) and emits `permission:role_assigned`. */
  async assignRole(userId: string, role: string, scope?: string): Promise<void> {
    assertUserId(userId, 'assignRole')
    assertRole(role, 'assignRole')
    scope = this.writeScope(scope, 'assignRole')
    await this.options.store.assignRole(userId, role, scope)
    await this.emit('permission:role_assigned', { userId, role, scope })
  }

  /** Takes a role away and emits `permission:role_removed`. */
  async removeRole(userId: string, role: string, scope?: string): Promise<void> {
    assertUserId(userId, 'removeRole')
    assertRole(role, 'removeRole')
    scope = this.writeScope(scope, 'removeRole')
    await this.options.store.removeRole(userId, role, scope)
    await this.emit('permission:role_removed', { userId, role, scope })
  }

  /** Grants permissions to a role and emits `permission:granted`. */
  async grantToRole(role: string, permissions: string[], scope?: string): Promise<void> {
    assertRole(role, 'grantToRole')
    assertPermissions(permissions, 'grantToRole')
    scope = this.writeScope(scope, 'grantToRole')
    await this.options.store.grantToRole(role, permissions, scope)
    await this.emit('permission:granted', { role, permissions, scope })
  }

  /** Grants permissions directly to a user and emits `permission:granted`. */
  async grantToUser(userId: string, permissions: string[], scope?: string): Promise<void> {
    assertUserId(userId, 'grantToUser')
    assertPermissions(permissions, 'grantToUser')
    scope = this.writeScope(scope, 'grantToUser')
    await this.options.store.grantToUser(userId, permissions, scope)
    await this.emit('permission:granted', { userId, permissions, scope })
  }

  /**
   * The permissions `role` carries when held in `scope`: the store's definition
   * in that scope, the `roleCatalog` entry, and — with
   * `inheritGlobalRolePermissions` — the store's global definition. Always
   * evaluated FOR `scope`: the caller only uses the result for a role held
   * there, so nothing here widens a grant to another tenant.
   */
  async rolePermissions(role: string, scope: string): Promise<string[]> {
    const permissions = new Set(await this.options.store.getRolePermissions(role, scope))
    for (const permission of this.roleCatalog.get(role) ?? []) permissions.add(permission)
    if (!isReservedScope(scope) && this.inheritGlobal(role)) {
      const globals = [GLOBAL_SCOPE, ...(this.options.readLegacyGlobalScope ? [LEGACY_GLOBAL_SCOPE] : [])]
      for (const global of globals) {
        for (const permission of await this.options.store.getRolePermissions(role, global)) permissions.add(permission)
      }
    }
    return [...permissions]
  }

  /** Standing grants (user + roles) plus active temporary grants — no delegation. */
  private async canDirect(userId: string, permission: string): Promise<boolean> {
    for (const scope of this.scopes()) {
      const granted = new Set(await this.options.store.getUserPermissions(userId, scope))
      for (const role of await this.options.store.getUserRoles(userId, scope)) {
        for (const perm of await this.rolePermissions(role, scope)) granted.add(perm)
      }
      if (this.options.temporaryGrants) {
        const now = this.now()
        for (const grant of await this.options.temporaryGrants.activeFor(userId, scope, now)) {
          // Re-verified here, not trusted: a durable store that forgets its
          // `expires_at > ?` (or its user/scope filter) would otherwise turn
          // every time-boxed grant into a standing one.
          if (!isLiveGrant(grant, userId, scope, now)) continue
          for (const perm of grant.permissions) granted.add(perm)
        }
      }
      for (const grantedPermission of granted) {
        if (permissionMatches(grantedPermission, permission)) return true
      }
    }
    return false
  }

  /** Active delegations to the user, bounded by the delegator's DIRECT permissions (no chaining). */
  private async canViaDelegation(userId: string, permission: string): Promise<boolean> {
    if (!this.options.delegations) return false
    const now = this.now()
    for (const scope of this.scopes()) {
      for (const d of await this.options.delegations.activeTo(userId, scope, now)) {
        if (!isLiveDelegation(d, userId, scope, now)) continue
        if (d.permissions.some((pattern) => permissionMatches(pattern, permission))) {
          if (await this.canDirect(d.fromUserId, permission)) return true
        }
      }
    }
    return false
  }

  /** Grant a user extra permissions until `expiresAt` (or `ttlMs` from now). Needs a `temporaryGrants` store. */
  async grantTemporarily(
    userId: string,
    permissions: string[],
    options: { expiresAt?: number; ttlMs?: number; scope?: string; grantedBy?: string; reason?: string } = {},
  ): Promise<TemporaryGrant> {
    if (!this.options.temporaryGrants) throw new Error('Gate has no temporaryGrants store configured')
    assertUserId(userId, 'grantTemporarily')
    assertPermissions(permissions, 'grantTemporarily')
    const now = this.now()
    // A deadline is the whole point of the method: with neither option the
    // grant used to expire the instant it was written — a silent no-op.
    let expiresAt: number
    if (options.expiresAt !== undefined) {
      expiresAt = options.expiresAt
    } else if (options.ttlMs !== undefined) {
      if (typeof options.ttlMs !== 'number' || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
        throw new TypeError('grantTemporarily: ttlMs must be a positive finite number of milliseconds')
      }
      expiresAt = now + options.ttlMs
    } else {
      throw new TypeError('grantTemporarily: pass ttlMs or expiresAt — a temporary grant needs a deadline')
    }
    assertDeadline(expiresAt, now, 'grantTemporarily')
    const grant: TemporaryGrant = {
      id: newDelegationId(),
      userId,
      permissions,
      scope: this.writeScope(options.scope, 'grantTemporarily'),
      expiresAt,
      ...(options.grantedBy !== undefined ? { grantedBy: options.grantedBy } : {}),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    }
    await this.options.temporaryGrants.add(grant)
    await this.emit('permission:granted', {
      userId,
      permissions,
      scope: grant.scope,
      expiresAt: grant.expiresAt,
    })
    return grant
  }

  /** Delegate a subset of `from`'s authority to `to` (bounded at check time). Needs a `delegations` store. */
  async delegate(input: {
    from: string
    to: string
    permissions: string[]
    scope?: string
    expiresAt?: number
  }): Promise<Delegation> {
    if (!this.options.delegations) throw new Error('Gate has no delegations store configured')
    assertUserId(input.from, 'delegate (from)')
    assertUserId(input.to, 'delegate (to)')
    assertPermissions(input.permissions, 'delegate')
    const now = this.now()
    if (input.expiresAt !== undefined) assertDeadline(input.expiresAt, now, 'delegate')
    const delegation: Delegation = {
      id: newDelegationId(),
      fromUserId: input.from,
      toUserId: input.to,
      permissions: input.permissions,
      scope: this.writeScope(input.scope, 'delegate'),
      createdAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }
    await this.options.delegations.add(delegation)
    await this.emit('permission:delegated', {
      fromUserId: delegation.fromUserId,
      toUserId: delegation.toUserId,
      permissions: delegation.permissions,
      scope: delegation.scope,
      ...(delegation.expiresAt !== undefined ? { expiresAt: delegation.expiresAt } : {}),
    })
    return delegation
  }

  /** Like can(), but throws PERMISSION_DENIED (403). */
  async authorize(user: PolicyUser, permission: string, resource?: unknown): Promise<void> {
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    if (!(await this.can(user, permission, resource))) {
      throw await this.denied(user.id, permission)
    }
  }

  /**
   * Whether the user actually holds `role` — in the current scope or globally.
   * Role membership, not authority: the `superAdmin` bypass does NOT make a
   * super admin a member of every role (it short-circuits `can()`/`authorize()`
   * instead). Ask {@link isSuperAdmin} for that, or — better — check the
   * permission the role stands for with `can()`.
   */
  async hasRole(user: PolicyUser, role: string): Promise<boolean> {
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    for (const scope of this.scopes()) {
      if ((await this.options.store.getUserRoles(user.id, scope)).includes(role)) return true
    }
    return false
  }

  /** Whether the configured `superAdmin` callback lets `user` bypass every check. `false` without one. */
  async isSuperAdmin(user: PolicyUser): Promise<boolean> {
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    return (await this.options.superAdmin?.(user)) === true
  }

  /**
   * Everything `user` may do right now, with where each permission comes from
   * — what `GET /me/access` answers. Covers every source a check consults:
   * direct and role grants in the current scope AND the global one (plus the
   * legacy global scope when read), live temporary grants, live delegations
   * (bounded, like the check, by the delegator's own direct permissions) and
   * the `superAdmin` bypass (reported as `'*'`).
   *
   * Side-effect free, like `can()`. Not a security surface: every request is
   * still decided by the Gate — this only lets an interface show the doors
   * that open and hide the ones that don't.
   */
  async describeAccess(user: PolicyUser): Promise<AccessReport> {
    if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
    const superAdmin = (await this.options.superAdmin?.(user)) === true
    const grants: AccessGrant[] = superAdmin ? [{ permission: '*', source: 'super-admin' }] : []
    grants.push(...(await this.directGrants(user.id)))

    if (this.options.delegations) {
      const now = this.now()
      for (const scope of this.scopes()) {
        for (const d of await this.options.delegations.activeTo(user.id, scope, now)) {
          if (!isLiveDelegation(d, user.id, scope, now)) continue
          const bound = await this.directGrants(d.fromUserId)
          for (const pattern of d.permissions) {
            for (const held of bound) {
              const permission = permissionMeet(pattern, held.permission)
              if (permission === undefined) continue
              const expiresAt = earliest(d.expiresAt ?? undefined, held.source === 'temporary' ? held.expiresAt : undefined)
              grants.push({
                permission,
                source: 'delegation',
                scope,
                id: d.id,
                fromUserId: d.fromUserId,
                ...(expiresAt !== undefined ? { expiresAt } : {}),
              })
            }
          }
        }
      }
    }

    return {
      roles: await this.effectiveRoles(user.id),
      permissions: [...new Set(grants.map((g) => g.permission))].sort(),
      superAdmin,
      grants: dedupeGrants(grants),
    }
  }

  /**
   * The grants {@link canDirect} honours for `userId`, with their source:
   * standing user and role grants plus live temporary grants, over every
   * scope a check consults. No delegation (delegations don't chain).
   */
  private async directGrants(userId: string): Promise<AccessGrant[]> {
    const grants: AccessGrant[] = []
    const now = this.now()
    for (const scope of this.scopes()) {
      for (const permission of await this.options.store.getUserPermissions(userId, scope)) {
        grants.push({ permission, source: 'direct', scope })
      }
      for (const role of await this.options.store.getUserRoles(userId, scope)) {
        for (const permission of await this.rolePermissions(role, scope)) {
          grants.push({ permission, source: 'role', scope, role })
        }
      }
      if (this.options.temporaryGrants) {
        for (const grant of await this.options.temporaryGrants.activeFor(userId, scope, now)) {
          if (!isLiveGrant(grant, userId, scope, now)) continue
          for (const permission of grant.permissions) {
            grants.push({ permission, source: 'temporary', scope, id: grant.id, expiresAt: grant.expiresAt })
          }
        }
      }
    }
    return grants
  }
}

/**
 * One permission in an {@link AccessReport} and where it comes from. `scope`
 * is where the grant lives — the tenant id or {@link GLOBAL_SCOPE}.
 */
export type AccessGrant =
  | { permission: string; source: 'direct'; scope: string }
  | { permission: string; source: 'role'; scope: string; role: string }
  /** A time-boxed grant (`grantTemporarily()`); inert after `expiresAt` (epoch ms). */
  | { permission: string; source: 'temporary'; scope: string; id: string; expiresAt: number }
  /**
   * Lent by `fromUserId` (`delegate()`), already narrowed to what the delegator
   * holds. `expiresAt` is the earlier of the delegation's deadline and that of
   * the delegator's temporary grant it rests on; absent when open-ended.
   */
  | { permission: string; source: 'delegation'; scope: string; id: string; fromUserId: string; expiresAt?: number }
  /** The `superAdmin` bypass: every check passes. */
  | { permission: '*'; source: 'super-admin' }

/** What {@link Gate.describeAccess} (and `GET /me/access`) answers. */
export interface AccessReport {
  /** Roles held in the current scope or globally — what `hasRole()` answers `true` for. */
  roles: string[]
  /** Every permission that opens a door, deduplicated and sorted — feed it to `permitted()`. */
  permissions: string[]
  /** `true` when the `superAdmin` bypass applies (then `permissions` contains `'*'`). */
  superAdmin: boolean
  /** Each permission with its provenance and, for time-boxed ones, its expiry. */
  grants: AccessGrant[]
}

/**
 * The permission pattern that matches exactly what both `a` and `b` match, or
 * `undefined` when nothing does. Segment-wise: `'*'` alone matches anything, a
 * `'*'` segment yields to the other side's segment, two literals must agree.
 */
function permissionMeet(a: string, b: string): string | undefined {
  if (!isValidPermission(a) || !isValidPermission(b)) return undefined
  if (a === '*') return b
  if (b === '*') return a
  const left = a.split(':')
  const right = b.split(':')
  if (left.length !== right.length) return undefined
  const out: string[] = []
  for (let i = 0; i < left.length; i++) {
    const l = left[i]!
    const r = right[i]!
    if (l === '*') out.push(r)
    else if (r === '*' || r === l) out.push(l)
    else return undefined
  }
  return out.join(':')
}

function earliest(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function dedupeGrants(grants: AccessGrant[]): AccessGrant[] {
  const seen = new Set<string>()
  return grants.filter((grant) => {
    const key = JSON.stringify(grant)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assertRole(value: unknown, operation: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${operation}: role must be a non-empty string`)
  }
}

/** A finite epoch-ms deadline in the future. `Infinity` is a standing grant, not a temporary one. */
function assertDeadline(value: unknown, now: number, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${operation}: expiresAt must be a finite epoch-ms timestamp`)
  }
  if (value <= now) throw new TypeError(`${operation}: expiresAt must be in the future`)
}

function isLiveGrant(grant: TemporaryGrant, userId: string, scope: string, now: number): boolean {
  return (
    grant.userId === userId &&
    grant.scope === scope &&
    typeof grant.expiresAt === 'number' &&
    Number.isFinite(grant.expiresAt) &&
    grant.expiresAt > now &&
    Array.isArray(grant.permissions)
  )
}

function isLiveDelegation(d: Delegation, userId: string, scope: string, now: number): boolean {
  if (d.toUserId !== userId || d.scope !== scope || !isUserId(d.fromUserId) || !Array.isArray(d.permissions)) return false
  // Open-ended: absent (or NULL from a SQL row). Anything else must be a real, future deadline.
  const expiresAt: unknown = d.expiresAt
  if (expiresAt === undefined || expiresAt === null) return true
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now
}

/**
 * `GET /me/access` — the roles and permissions of whoever is asking.
 *
 * `/auth/me` answers who you are; nothing answered what you may do. So every
 * frontend that hides a menu by permission wrote the same twenty lines: read
 * the roles, read the direct grants, read each role's grants, merge, dedupe.
 *
 * Not a security surface — the server decides on every request regardless. This
 * exists so the interface stops offering doors that return 403, and stops
 * hiding doors that would have opened: the answer is {@link Gate.describeAccess}
 * — current-scope AND global grants, live temporary grants and delegations
 * (each marked with its source and expiry), and the `superAdmin` bypass.
 *
 * Pair it with `@basaltkit/permissions/match`, which carries the same wildcard
 * rule and imports nothing, so the browser applies the server's rule instead of
 * a copy that drifts from it.
 *
 * ```ts
 * fastifyPlugin({ routes: [...accessRoutes(), ...myRoutes] })
 * ```
 */
export function accessRoutes(
  options: { path?: string; store?: AccessStore } = {},
): BasaltRoute[] {
  const empty = (): AccessReport => ({ roles: [], permissions: [], superAdmin: false, grants: [] })
  return [
    route({
      method: 'GET',
      url: options.path ?? '/me/access',
      // No `meta.auth`: a public page asks this before anyone logs in. Empty is
      // the honest answer there, and a 401 would make the frontend treat "not
      // logged in" as an error to report.
      async handler(): Promise<AccessReport> {
        const context = tryCtx()
        const user = context?.['user'] as { id: string } | undefined
        if (!isPolicyUser(user)) return empty()

        // From the option, or from the Gate the plugin registered. There is no
        // token for the store itself, and adding one here would be a second way
        // to reach the same object.
        const container = context?.['container'] as Container | undefined
        const registered = container?.has(GATE) ? container.get(GATE) : undefined
        const store = options.store ?? registered?.store
        if (!store) return empty()
        // The registered Gate answers when it reads the same store — so the
        // report carries everything its checks honour (roleCatalog, inherited
        // global definitions, temporary grants, delegations, superAdmin).
        // Otherwise a Gate over the given store reads the standing grants.
        if (registered && store === registered.store) {
          return registered.describeAccess((await registered.actor()) ?? user)
        }
        return new Gate({ store }).describeAccess(user)
      },
    }),
  ]
}

export const GATE = createToken<Gate>('gate')

export type PermissionsPluginOptions = GateOptions & {
  /**
   * Surfaces, keyed by name. Omit it and nothing changes.
   *
   * A caller holding at least one role no rule names is **unconfined** and
   * reaches everything their permissions allow. A caller whose every role is
   * confined may reach only routes whose `meta.audience` one of their rules
   * allows — and a route that declares no audience is reachable by none of
   * them.
   *
   * That default is the point. The obvious design is to mark the internal
   * routes, and it fails the first time somebody adds a route without thinking
   * about portals: the leak this exists to prevent was exactly that, an
   * authenticated client receiving 200 on an internal listing. Marking the
   * small, deliberate surface a restricted role may reach is a list somebody
   * maintains; marking every route they may not is a list somebody forgets.
   */
  audiences?: Record<string, AudienceRule>
  /**
   * What the `meta.can` guard answers when a resource requirement's loader
   * finds nothing (`null`/`undefined`): `'not-found'` (default) throws
   * {@link ResourceNotFoundError} (404); `'deny'` refuses like a failed check
   * (403 `PERMISSION_DENIED`, audited), so a caller cannot probe which ids
   * exist. A requirement's own `notFound` overrides it.
   */
  resourceNotFound?: CanResourceNotFound
}

/** See `resourceNotFound` in {@link PermissionsPluginOptions}. */
export type CanResourceNotFound = 'not-found' | 'deny'

/**
 * What a `meta.can` resource loader receives. `params`, `query` and `body` are
 * parsed by the route's schemas exactly as the handler will receive them
 * (`undefined` when the route declares no schema for that part; the body is
 * `undefined` for `upload()`/`rawBody()` routes, which stream it later).
 * Typed `any` because the route's schemas are not visible at the meta's type.
 */
export interface CanResourceInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  /** The authenticated caller (the guard answers 401 before any load). */
  user: PolicyUser
  /** The request's tenant (`ctx().tenant`), when tenancy resolved one. */
  tenant: unknown
  /** The request-scoped container. */
  container: Container
  /** The raw request — headers, unparsed input. */
  request: HttpRequest
  route: BasaltRoute
}

/**
 * Loads the resource a `meta.can` requirement is checked against. Return
 * `null`/`undefined` for "not found" (see {@link CanResourceNotFound}); a throw
 * propagates as-is.
 */
export type CanResourceLoader<TResource = unknown> = (
  input: CanResourceInput,
) => TResource | null | undefined | Promise<TResource | null | undefined>

/**
 * A resource-aware `meta.can` entry: the guard loads the resource, then
 * `gate.authorize(user, permission, resource)` lets the registered policy for
 * `permission` decide — the same call a handler would make by hand.
 *
 * ```ts
 * meta: { can: { permission: 'projects:update', resource: ({ params }) => projects.find(params.id) } }
 * ```
 */
export interface CanRequirement<TResource = unknown> {
  permission: string
  resource: CanResourceLoader<TResource>
  /** Overrides the plugin's `resourceNotFound` for this requirement. */
  notFound?: CanResourceNotFound
}

/**
 * The value of `meta.can`: a permission, a resource requirement, or a
 * non-empty array mixing both — every entry is required (all-of).
 */
export type CanMeta = string | CanRequirement | readonly (string | CanRequirement)[]

const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(['permission', 'resource', 'notFound'])

/** Why `entry` is not a valid resource requirement, or `undefined` when it is. */
function requirementProblem(entry: object): string | undefined {
  if (Array.isArray(entry)) return 'a nested array is not a requirement'
  const unknownKeys = Object.keys(entry).filter((key) => !REQUIREMENT_KEYS.has(key))
  if (unknownKeys.length > 0) {
    return `unknown key(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(', ')} (expected permission, resource, notFound)`
  }
  const { permission, resource, notFound } = entry as Partial<CanRequirement>
  if (!isValidPermission(permission)) {
    return 'permission must be a non-empty string without whitespace, control characters or empty ":" segments'
  }
  if (typeof resource !== 'function') return `resource must be a loader function (${permission})`
  if (notFound !== undefined && notFound !== 'not-found' && notFound !== 'deny') {
    return `notFound must be 'not-found' or 'deny' (${permission})`
  }
  return undefined
}

const isRequirementLike = (entry: unknown): entry is object => typeof entry === 'object' && entry !== null

/**
 * The entries a `meta.can` value requires: a non-empty string is one
 * permission, a valid resource requirement is one requirement, a non-empty
 * array of those is all of them. Anything else is `null` — unenforceable, so
 * the guard fails closed on it.
 */
function canMetaEntries(required: unknown): (string | CanRequirement)[] | null {
  if (typeof required === 'string') return required.length > 0 ? [required] : null
  if (Array.isArray(required)) {
    if (required.length === 0) return null
    const entries: (string | CanRequirement)[] = []
    for (const entry of required as unknown[]) {
      if (typeof entry === 'string' && entry.length > 0) entries.push(entry)
      else if (isRequirementLike(entry) && requirementProblem(entry) === undefined) entries.push(entry as CanRequirement)
      else return null
    }
    return entries
  }
  if (isRequirementLike(required) && requirementProblem(required) === undefined) return [required as CanRequirement]
  return null
}

/** True when `required` uses the resource-requirement form anywhere (an object entry). */
function declaresRequirement(required: unknown): boolean {
  if (Array.isArray(required)) return (required as unknown[]).some(isRequirementLike)
  return isRequirementLike(required)
}

/**
 * Where the guard leaves the resources it resolved for the handler
 * ({@link canResource}). A registered symbol: not a string any enricher could
 * collide with, and still the same key across two copies of this package.
 */
const CAN_RESOURCES = Symbol.for('basalt.permissions.canResources')

/**
 * The resource the `meta.can` guard loaded for this request, so the handler
 * does not load it a second time:
 *
 * ```ts
 * route({
 *   method: 'PATCH', url: '/projects/:id', params: z.object({ id: z.string() }),
 *   meta: { can: { permission: 'projects:update', resource: ({ params }) => projects.find(params.id) } },
 *   handler: ({ body }) => projects.update(canResource<Project>(), body),
 * })
 * ```
 *
 * Pass the permission when the route declares several requirements whose
 * loaders return different resources. Throws
 * {@link CanResourceUnavailableError} when the guard resolved none — a route
 * without a resource requirement, or code running outside the request.
 */
export function canResource<TResource = unknown>(permission?: string): TResource {
  const context = tryCtx() as Record<PropertyKey, unknown> | undefined
  const resolved = context?.[CAN_RESOURCES] as ReadonlyMap<string, unknown> | undefined
  if (!resolved || resolved.size === 0) {
    throw new CanResourceUnavailableError('no meta.can resource was resolved for this request')
  }
  if (permission !== undefined) {
    if (!resolved.has(permission)) {
      throw new CanResourceUnavailableError(`no meta.can resource was resolved for "${permission}"`)
    }
    return resolved.get(permission) as TResource
  }
  const distinct = [...new Set(resolved.values())]
  if (distinct.length > 1) {
    throw new CanResourceUnavailableError(
      `this route resolved ${distinct.length} different resources — pass the permission (${[...resolved.keys()].join(', ')})`,
    )
  }
  return distinct[0] as TResource
}

type ParsedPart = 'body' | 'query' | 'params'

/** The pipeline's own parse (same schema, same 400), for the resource loader. */
function parseForLoader(part: ParsedPart, schema: BasaltRoute['params'], input: unknown): unknown {
  if (!schema) return undefined
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
  throw new RequestValidationError(part, issues)
}

function loaderInput(
  route: BasaltRoute,
  request: HttpRequest,
  user: PolicyUser,
  context: Record<string, unknown>,
  container: Container,
): CanResourceInput {
  // Guards run before the pipeline validates, so the input is parsed here —
  // in the pipeline's order, with its schemas — and parsed again for the
  // handler: keep schema transforms pure. A streamed body is never touched.
  const streamed = uploadOptionsOf(route.body) !== undefined || rawBodyOptionsOf(route.body) !== undefined
  const body = streamed ? undefined : parseForLoader('body', route.body, request.body)
  const query = parseForLoader('query', route.query, request.query)
  const params = parseForLoader('params', route.params, request.params)
  return { params, query, body, user, tenant: context['tenant'], container, request, route }
}

export function permissionsPlugin(options: PermissionsPluginOptions) {
  return definePlugin({
    name: 'basalt:permissions',
    register({ container, hooks }) {
      // 'tenancy:active' is tenancyPlugin's marker — a signal, not an import.
      // Read lazily, so it is seen whichever plugin registers first.
      const tenancyActive = options.tenancyActive ?? (() => ensureMetadata(container).get('tenancy:active').length > 0)
      container.singleton(GATE, () => new Gate({ ...options, hooks: options.hooks ?? hooks, tenancyActive }))
      const missingPolicy = options.onMissingPolicy ?? 'error'
      const defaultNotFound: CanResourceNotFound = options.resourceNotFound ?? 'not-found'

      // Guard: routes declaring meta.can require every entry. A string is an
      // RBAC permission; a resource requirement loads the resource and lets
      // its policy decide; an array requires ALL of them (all-of). Any other
      // shape (true, a number, an empty/mixed array, a malformed requirement)
      // is unenforceable and fails CLOSED with InvalidCanMetaError instead of
      // silently skipping the check — the historic `typeof !== 'string' →
      // return` was a fail-open.
      const guard: RouteGuard = async ({ route, request, context, container: c }) => {
        const required = route.meta?.['can']
        if (required === undefined) return
        const entries = canMetaEntries(required)
        if (entries === null) {
          throw new InvalidCanMetaError(`${route.method} ${route.url}`, required)
        }
        // A user object without a usable id is not an authenticated caller.
        const user: unknown = context.user
        if (!isPolicyUser(user)) throw new AuthRequiredGuardError()
        const gate = c.get(GATE)
        // Plain permissions first: cheap, and a caller refused by RBAC never
        // makes a loader hit the database.
        const requirements: CanRequirement[] = []
        for (const entry of entries) {
          if (typeof entry === 'string') await gate.authorize(user, entry)
          else requirements.push(entry)
        }
        if (requirements.length === 0) return

        const input = loaderInput(route, request, user, context as Record<string, unknown>, c)
        // One load per loader: two requirements sharing a loader check the
        // same resource ('projects:update' and 'projects:publish').
        const loaded = new Map<CanResourceLoader, unknown>()
        const resolved = new Map<string, unknown>()
        for (const requirement of requirements) {
          let resource: unknown
          if (loaded.has(requirement.resource)) resource = loaded.get(requirement.resource)
          else {
            resource = await requirement.resource(input)
            loaded.set(requirement.resource, resource)
          }
          if (resource === null || resource === undefined) {
            if ((requirement.notFound ?? defaultNotFound) === 'deny') throw await gate.denied(user.id, requirement.permission)
            throw new ResourceNotFoundError()
          }
          // The policy for `permission` decides (MissingPolicyError without
          // one, unless onMissingPolicy: 'rbac').
          await gate.authorize(user, requirement.permission, resource)
          resolved.set(requirement.permission, resource)
        }
        ;(context as Record<PropertyKey, unknown>)[CAN_RESOURCES] = resolved
      }

      // Boot-time check of the resource form (every adapter runs
      // `http:meta-validators` over its routes): a malformed requirement, or
      // one whose permission no policy decides, refuses the boot instead of
      // answering 500 on the first request. The string forms keep their
      // runtime fail-closed only — tightening them at boot would break apps
      // that boot today. The guard still re-checks everything at runtime.
      const validator: RouteMetaValidator = ({ route, container: c }) => {
        const required: unknown = route.meta?.['can']
        if (!declaresRequirement(required)) return
        const problems: string[] = []
        const entries = Array.isArray(required) ? (required as unknown[]) : [required]
        if (entries.length === 0) problems.push('meta.can is an empty array')
        for (const entry of entries) {
          if (typeof entry === 'string') {
            if (entry.length === 0) problems.push('meta.can contains an empty permission string')
            continue
          }
          if (!isRequirementLike(entry)) {
            problems.push(`meta.can contains an entry of type ${typeof entry} (expected a permission or a requirement)`)
            continue
          }
          const problem = requirementProblem(entry)
          if (problem !== undefined) {
            problems.push(`meta.can requirement: ${problem}`)
            continue
          }
          const { permission } = entry as CanRequirement
          if (missingPolicy === 'error' && !c.get(GATE).hasPolicy(permission)) {
            problems.push(
              `meta.can requirement "${permission}" loads a resource but no policy decides it — ` +
                `register definePolicy('${permission.split(':')[0]}', { ${permission.split(':')[1] ?? '…'}: … }), ` +
                `fix the resource:action spelling, or set onMissingPolicy: 'rbac'`,
            )
          }
        }
        return problems.length > 0 ? problems : undefined
      }
      // Guard: a confined role reaches only the surfaces its rule allows.
      //
      // Separate from the `can` guard, and running whatever the route declares,
      // because the two answer different questions. `can` asks whether the
      // caller may perform the action at all; this asks whether this route is
      // one they are allowed to see. A route with no `can` still has a surface.
      const rules = Object.values(options.audiences ?? {})
      const audienceGuard: RouteGuard = async ({ route, container: c }) => {
        if (rules.length === 0) return
        const gate = c.get(GATE)
        const actor = await gate.actor()
        // No user: `meta.auth`/`meta.can` decide that, not this. Confining an
        // anonymous caller here would turn every public route into a 403.
        if (!actor) return

        // The tenant's own roles, or — when the tenant grants none — the
        // global ones (`gate.audienceRoles()`). Not `actor.roles` alone (a
        // confined role assigned globally would vanish inside a tenant and its
        // holder reach internal routes), and not the union with global roles
        // either (one unnamed global baseline role would un-confine a tenant's
        // client everywhere). Narrowed rather than cast: a store returning
        // non-strings must not throw here.
        const raw: unknown = await gate.audienceRoles(actor.id)
        const roles: string[] = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : []
        // No roles at all is not an audience. Such a caller holds no permission
        // either, so `meta.can` already answers for every route that declares
        // one; confining them here would 403 the public pages too.
        if (roles.length === 0) return

        // Confined only when EVERY role they hold is named by some rule. One
        // unnamed role — a lawyer who is also a client of the firm — and the
        // audiences say nothing about them. Refusing that person would lock a
        // member of staff out of their own workplace the day they became a
        // client.
        const confining = rules.filter((rule) => rule.roles.some((role) => roles.includes(role)))
        const named = (role: string): boolean => rules.some((rule) => rule.roles.includes(role))
        if (!roles.every(named)) return

        const audience = route.meta?.['audience']
        // The default, and the whole reason this exists: a route that never
        // mentions an audience is not reachable by a confined role. Reversing
        // this — allow unless marked internal — is what let a portal client
        // read an internal listing.
        if (typeof audience !== 'string') throw await gate.denied(actor.id, 'audience')
        // The union of what their rules allow: two confined roles each grant
        // reach to their own surface, and holding both grants reach to both.
        if (!confining.some((rule) => rule.allow.includes(audience))) {
          throw await gate.denied(actor.id, `audience:${audience}`)
        }
      }

      // Side-effect-free twin of the `can` guard for listings (`tools/list` of
      // @basaltkit/mcp): hide a `meta.can` route from a caller who statically
      // lacks a plain permission it requires. `gate.can()` WITHOUT a resource
      // is a pure read — store lookups and the `superAdmin` callback, never a
      // hook, a denial record or a write (`authorize()`/`denied()` are what
      // emit).
      //
      // A resource requirement is never loaded here — a listing must not hit
      // the database or run a policy per route. Its policy decides per
      // resource (an owner may pass holding no grant at all), so it raises no
      // objection for an authenticated caller: the tool stays listed and the
      // guard decides on the call. Pair it with the plain permission
      // (`['projects:update', { permission: 'projects:update', resource }]`)
      // to also require — and list by — the RBAC grant. Without a policy
      // under `onMissingPolicy: 'rbac'` the guard answers from RBAC, and so
      // does this; without one under `'error'` every call fails, so it hides.
      const visibility: RouteVisibilityCheck = async ({ route, context, container: c }) => {
        const required = route.meta?.['can']
        if (required === undefined) return true
        const entries = canMetaEntries(required)
        // Malformed meta: the guard throws on every call, so nobody can pass.
        if (entries === null) return false
        const user: unknown = context['user']
        if (!isPolicyUser(user)) return false
        const gate = c.get(GATE)
        for (const entry of entries) {
          const permission = typeof entry === 'string' ? entry : entry.permission
          if (typeof entry !== 'string' && gate.hasPolicy(permission)) continue
          if (typeof entry !== 'string' && missingPolicy === 'error') return false
          if (!(await gate.can(user, permission))) return false
        }
        return true
      }

      const metadata = ensureMetadata(container)
      metadata.add('http:guards', guard)
      metadata.add('http:guards', audienceGuard)
      metadata.add('http:route-visibility', visibility)
      metadata.add('http:meta-validators', validator)
      // Claim `meta.can` for the adapters' boot check (routes declaring it
      // without this plugin fail loud at boot instead of serving unchecked).
      metadata.add('http:guarded-meta', 'can')
      metadata.add('http:guarded-meta', 'audience')
    },
  })
}

export {
  MemoryTemporaryGrantStore,
  MemoryDelegationStore,
  type TemporaryGrant,
  type TemporaryGrantStore,
  type Delegation,
  type DelegationStore,
} from './delegation.js'
