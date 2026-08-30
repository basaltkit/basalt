import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import {
  newDelegationId,
  type TemporaryGrant,
  type TemporaryGrantStore,
  type Delegation,
  type DelegationStore,
} from './delegation.js'
import type { RouteGuard } from '@basaltkit/http'
import { AuthRequiredGuardError, InvalidCanMetaError, MissingPolicyError } from './errors.js'

export { AuthRequiredGuardError, InvalidCanMetaError, MissingPolicyError, PermissionDeniedError } from './errors.js'
import { PermissionDeniedError } from './errors.js'

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

/** 'projects:*' grants 'projects:delete'; '*' grants everything. */
export function permissionMatches(granted: string, requested: string): boolean {
  if (granted === requested || granted === '*') return true
  const grantedParts = granted.split(':')
  const requestedParts = requested.split(':')
  if (grantedParts.length !== requestedParts.length) return false
  return grantedParts.every((part, index) => part === '*' || part === requestedParts[index])
}

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

export const GATE = createToken<Gate>('gate')

export type PermissionsPluginOptions = GateOptions

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
      const metadata = ensureMetadata(container)
      metadata.add('http:guards', guard)
      // Claim `meta.can` for the adapters' boot check (routes declaring it
      // without this plugin fail loud at boot instead of serving unchecked).
      metadata.add('http:guarded-meta', 'can')
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
