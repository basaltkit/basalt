import { createToken, definePlugin, ensureMetadata, tryCtx, type BasaltHooks, type Container, type HookBus } from '@basaltkit/core'
import {
  newDelegationId,
  type TemporaryGrant,
  type TemporaryGrantStore,
  type Delegation,
  type DelegationStore,
} from './delegation.js'
import { route, type BasaltRoute, type RouteGuard } from '@basaltkit/http'
import { AuthRequiredGuardError, InvalidCanMetaError, MissingPolicyError, ReservedScopeError } from './errors.js'

export {
  AuthRequiredGuardError,
  InvalidCanMetaError,
  MissingPolicyError,
  PermissionDeniedError,
  ReservedScopeError,
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
    /** Permission the caller must hold. Enforced by `permissionsPlugin`. */
    can?: string | string[]
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
    const key = this.key(userId, scope)
    const roles = this.userRoles.get(key) ?? new Set()
    roles.add(role)
    this.userRoles.set(key, roles)
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    this.userRoles.get(this.key(userId, scope))?.delete(role)
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    const key = this.key(role, scope)
    const set = this.rolePermissions.get(key) ?? new Set()
    for (const permission of permissions) set.add(permission)
    this.rolePermissions.set(key, set)
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
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
export { permissionMatches, permitted } from './match.js'
import { permissionMatches } from './match.js'

export interface PolicyUser {
  id: string
  [key: string]: unknown
}

export type PolicyCheck<TResource = unknown> = (
  user: PolicyUser,
  resource: TResource,
) => boolean | Promise<boolean>

export interface Policy<TResource = unknown> {
  resource: string
  checks: Record<string, PolicyCheck<TResource>>
}

/**
 * Contextual (ABAC) rules for a resource type:
 *
 * const ProjectPolicy = definePolicy('project', {
 *   update: (user, project) => project.ownerId === user.id,
 * })
 */
export function definePolicy<TResource>(
  resource: string,
  checks: Record<string, PolicyCheck<TResource>>,
): Policy<TResource> {
  return { resource, checks }
}

export interface GateOptions {
  store: AccessStore
  /** Short-circuits every check — Laravel's Gate::before. */
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
      if (typeof permission !== 'string' || permission.length === 0) {
        throw new TypeError(`roleCatalog.${role} must contain only non-empty permission strings`)
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
    this.policies.set(policy.resource, policy)
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
    if (!user?.id) return null

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
   */
  async can(user: PolicyUser, permission: string, resource?: unknown): Promise<boolean> {
    if (await this.options.superAdmin?.(user)) return true

    if (resource !== undefined) {
      const [resourceName, action] = permission.split(':')
      const policy = resourceName ? this.policies.get(resourceName) : undefined
      const check = action ? policy?.checks[action] : undefined
      if (check) return check(user, resource as never)
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

  private scopes(): string[] {
    const scopes = [this.scope(), GLOBAL_SCOPE]
    if (this.options.readLegacyGlobalScope) scopes.push(LEGACY_GLOBAL_SCOPE)
    return scopes.filter((scope, index, all) => all.indexOf(scope) === index)
  }

  /** The union of the user's roles over every scope a check consults. */
  async effectiveRoles(userId: string): Promise<string[]> {
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
  async assignRole(userId: string, role: string, scope: string = this.scope()): Promise<void> {
    await this.options.store.assignRole(userId, role, scope)
    await this.emit('permission:role_assigned', { userId, role, scope })
  }

  /** Takes a role away and emits `permission:role_removed`. */
  async removeRole(userId: string, role: string, scope: string = this.scope()): Promise<void> {
    await this.options.store.removeRole(userId, role, scope)
    await this.emit('permission:role_removed', { userId, role, scope })
  }

  /** Grants permissions to a role and emits `permission:granted`. */
  async grantToRole(role: string, permissions: string[], scope: string = this.scope()): Promise<void> {
    await this.options.store.grantToRole(role, permissions, scope)
    await this.emit('permission:granted', { role, permissions, scope })
  }

  /** Grants permissions directly to a user and emits `permission:granted`. */
  async grantToUser(userId: string, permissions: string[], scope: string = this.scope()): Promise<void> {
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
        for (const grant of await this.options.temporaryGrants.activeFor(userId, scope, this.now())) {
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
    const grant: TemporaryGrant = {
      id: newDelegationId(),
      userId,
      permissions,
      scope: options.scope ?? this.scope(),
      expiresAt: options.expiresAt ?? this.now() + (options.ttlMs ?? 0),
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
    const delegation: Delegation = {
      id: newDelegationId(),
      fromUserId: input.from,
      toUserId: input.to,
      permissions: input.permissions,
      scope: input.scope ?? this.scope(),
      createdAt: this.now(),
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
    if (!(await this.can(user, permission, resource))) {
      throw await this.denied(user.id, permission)
    }
  }

  async hasRole(user: PolicyUser, role: string): Promise<boolean> {
    if (await this.options.superAdmin?.(user)) return true
    for (const scope of this.scopes()) {
      if ((await this.options.store.getUserRoles(user.id, scope)).includes(role)) return true
    }
    return false
  }
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
 * hiding doors that would have opened.
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
  return [
    route({
      method: 'GET',
      url: options.path ?? '/me/access',
      // No `meta.auth`: a public page asks this before anyone logs in. Empty is
      // the honest answer there, and a 401 would make the frontend treat "not
      // logged in" as an error to report.
      async handler() {
        const context = tryCtx()
        const user = context?.['user'] as { id: string } | undefined
        if (!user?.id) return { roles: [], permissions: [] }

        // From the option, or from the Gate the plugin registered. There is no
        // token for the store itself, and adding one here would be a second way
        // to reach the same object.
        const container = context?.['container'] as Container | undefined
        const gate = container?.has(GATE) ? container.get(GATE) : undefined
        const store = options.store ?? gate?.store
        if (!store) return { roles: [], permissions: [] }
        // The Gate's resolution (roleCatalog, inherited global definitions) when
        // the answer comes from the Gate's own store — otherwise the menu hides
        // what the server would allow.
        const rolePermissions =
          gate && store === gate.store
            ? (role: string, scope: string) => gate.rolePermissions(role, scope)
            : (role: string, scope: string) => store.getRolePermissions(role, scope)

        const scope = currentScope()
        const roles = await store.getUserRoles(user.id, scope)

        // Direct grants plus everything each role carries. The union is what a
        // frontend needs; assembling it there means reimplementing the model.
        const diretas = await store.getUserPermissions(user.id, scope)
        const dosPapeis = await Promise.all(roles.map((r) => rolePermissions(r, scope)))

        return { roles, permissions: [...new Set([...diretas, ...dosPapeis.flat()])].sort() }
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
}

export function permissionsPlugin(options: PermissionsPluginOptions) {
  return definePlugin({
    name: 'basalt:permissions',
    register({ container, hooks }) {
      container.singleton(GATE, () => new Gate({ ...options, hooks: options.hooks ?? hooks }))

      // Guard: routes declaring meta.can require the permission(s). A string
      // requires that permission; an array requires ALL of them (all-of). Any
      // other shape (true, a number, an empty/mixed array) is unenforceable and
      // fails CLOSED with InvalidCanMetaError instead of silently skipping the
      // check — the historic `typeof !== 'string' → return` was a fail-open.
      const guard: RouteGuard = async ({ route, context, container: c }) => {
        const required = route.meta?.['can']
        if (required === undefined) return
        const permissions =
          typeof required === 'string' && required.length > 0
            ? [required]
            : Array.isArray(required) &&
                required.length > 0 &&
                required.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)
              ? required
              : null
        if (permissions === null) {
          throw new InvalidCanMetaError(`${route.method} ${route.url}`, required)
        }
        const user = context.user as PolicyUser | undefined
        if (!user) throw new AuthRequiredGuardError()
        const gate = c.get(GATE)
        for (const permission of permissions) await gate.authorize(user, permission)
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

      const metadata = ensureMetadata(container)
      metadata.add('http:guards', guard)
      metadata.add('http:guards', audienceGuard)
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
