import { createToken, definePlugin, ensureMetadata, MachizeError, tryCtx } from '@machize/core'
import type { RouteGuard } from '@machize/fastify'
import { AuthRequiredGuardError } from './errors.js'

export { AuthRequiredGuardError, PermissionDeniedError } from './errors.js'
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
}

const defaultScope = (): string => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ?? GLOBAL_SCOPE
}

export class Gate {
  private readonly policies = new Map<string, Policy<never>>()
  private readonly scope: () => string

  constructor(private readonly options: GateOptions) {
    this.scope = options.scope ?? defaultScope
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
    }

    const scopes = [this.scope(), GLOBAL_SCOPE].filter(
      (scope, index, all) => all.indexOf(scope) === index,
    )
    for (const scope of scopes) {
      const granted = new Set(await this.options.store.getUserPermissions(user.id, scope))
      for (const role of await this.options.store.getUserRoles(user.id, scope)) {
        for (const permissionOfRole of await this.options.store.getRolePermissions(role, scope)) {
          granted.add(permissionOfRole)
        }
      }
      for (const grantedPermission of granted) {
        if (permissionMatches(grantedPermission, permission)) return true
      }
    }
    return false
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
    name: 'machize:permissions',
    register({ container }) {
      container.singleton(GATE, () => new Gate(options))

      // Guard: routes declaring meta.can require the permission.
      const guard: RouteGuard = async ({ route, context, container: c }) => {
        const required = route.meta?.['can']
        if (typeof required !== 'string') return
        const user = context.user as PolicyUser | undefined
        if (!user) throw new AuthRequiredGuardError()
        await c.get(GATE).authorize(user, required)
      }
      ensureMetadata(container).add('http:guards', guard)
    },
  })
}
