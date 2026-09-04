import { createToken, definePlugin, ensureMetadata, tryCtx, type Container } from '@basaltkit/core'
import {
  newDelegationId,
  type TemporaryGrant,
  type TemporaryGrantStore,
  type Delegation,
  type DelegationStore,
} from './delegation.js'
import { route, type BasaltRoute, type RouteGuard } from '@basaltkit/http'
import { AuthRequiredGuardError, InvalidCanMetaError, MissingPolicyError } from './errors.js'

export { AuthRequiredGuardError, InvalidCanMetaError, MissingPolicyError, PermissionDeniedError } from './errors.js'
import { PermissionDeniedError } from './errors.js'

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


/** Global scope key — role/permission grants outside any tenant. */
export const GLOBAL_SCOPE = 'global'

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

  private key(a: string, scope: string): string {
    return `${scope}::${a}`
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
}

const defaultScope = (): string => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ?? GLOBAL_SCOPE
}

export class Gate {
  /** The grants this gate reads. Exposed for `accessRoutes()`; treat as read-only. */
  get store(): AccessStore {
    return this.options.store
  }

  private readonly policies = new Map<string, Policy<never>>()
  private readonly scope: () => string
  private readonly now: () => number

  constructor(private readonly options: GateOptions) {
    this.scope = options.scope ?? defaultScope
    this.now = options.now ?? (() => Date.now())
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
    return [this.scope(), GLOBAL_SCOPE].filter((scope, index, all) => all.indexOf(scope) === index)
  }

  /** Standing grants (user + roles) plus active temporary grants — no delegation. */
  private async canDirect(userId: string, permission: string): Promise<boolean> {
    for (const scope of this.scopes()) {
      const granted = new Set(await this.options.store.getUserPermissions(userId, scope))
      for (const role of await this.options.store.getUserRoles(userId, scope)) {
        for (const perm of await this.options.store.getRolePermissions(role, scope)) granted.add(perm)
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
    return delegation
  }

  /** Like can(), but throws PERMISSION_DENIED (403). */
  async authorize(user: PolicyUser, permission: string, resource?: unknown): Promise<void> {
    if (!(await this.can(user, permission, resource))) {
      throw new PermissionDeniedError(permission)
    }
  }

  async hasRole(user: PolicyUser, role: string): Promise<boolean> {
    if (await this.options.superAdmin?.(user)) return true
    const scopes = [this.scope(), GLOBAL_SCOPE]
    for (const scope of scopes) {
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
        const store = options.store ?? (container?.has(GATE) ? container.get(GATE).store : undefined)
        if (!store) return { roles: [], permissions: [] }

        const scope = (context?.['tenant'] as { id: string } | undefined)?.id ?? GLOBAL_SCOPE
        const roles = await store.getUserRoles(user.id, scope)

        // Direct grants plus everything each role carries. The union is what a
        // frontend needs; assembling it there means reimplementing the model.
        const diretas = await store.getUserPermissions(user.id, scope)
        const dosPapeis = await Promise.all(roles.map((r) => store.getRolePermissions(r, scope)))

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
    register({ container }) {
      container.singleton(GATE, () => new Gate(options))

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

        // `PolicyUser` is open (`[key: string]: unknown`), so `roles` arrives
        // untyped even though `gate.actor()` is what filled it. Narrowed here
        // rather than cast: a store that returned something else should make
        // this guard do nothing, not throw inside a security check.
        const raw = actor['roles']
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
        if (typeof audience !== 'string') throw new PermissionDeniedError('audience')
        // The union of what their rules allow: two confined roles each grant
        // reach to their own surface, and holding both grants reach to both.
        if (!confining.some((rule) => rule.allow.includes(audience))) {
          throw new PermissionDeniedError(`audience:${audience}`)
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
