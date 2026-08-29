import { createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import type { RouteGuard } from '@basaltkit/http'
import { InsufficientTeamRoleError, NotATeamMemberError, Teams, type TeamsOptions } from './teams.js'
import type { Membership, PublicInvitation, TeamRole } from './stores.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    /** An invitation was created — the app emails the token as a link. */
    'team:invited': { invitation: PublicInvitation; token: string }
    'team:joined': { membership: Membership }
    'team:role_changed': { membership: Membership }
    'team:member_removed': { tenantId: string; userId: string }
  }
}

export const TEAMS = createToken<Teams>('teams')

export type TeamsPluginOptions = Omit<TeamsOptions, 'hooks'>

/**
 * Team membership + invitations. Registers the {@link Teams} service and a
 * guard enforcing `meta.teamRole` on routes: the current user (`ctx().user`)
 * must hold that role or higher in the current tenant (`ctx().tenant`).
 */
export function teamsPlugin(options: TeamsPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:teams',
    register({ container, hooks }) {
      container.singleton(TEAMS, () => new Teams({ ...options, hooks }))
      const metadata = ensureMetadata(container)

      const guard: RouteGuard = async ({ route, context, container: c }) => {
        const required = route.meta?.['teamRole'] as TeamRole | undefined
        if (!required) return

        const ctxLike = context as { tenant?: { id: string }; user?: { id: string } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        if (!tenantId || !userId) throw new NotATeamMemberError()

        if (!(await c.get(TEAMS).can(tenantId, userId, required))) {
          throw new InsufficientTeamRoleError(required)
        }
      }
      metadata.add('http:guards', guard)
      // Claim `meta.teamRole` for the adapters' boot check (routes declaring
      // it without this plugin fail loud at boot instead of serving unchecked).
      metadata.add('http:guarded-meta', 'teamRole')
    },
  })
}

export interface TenantMembershipPluginOptions {
  /**
   * Require a minimum RANKED role instead of plain membership. Default:
   * undefined — any membership record passes (an existence check), so members
   * holding custom roles that are absent from `roleRank` are not rejected.
   * Set e.g. `role: 'member'` to enforce rank semantics explicitly.
   */
  role?: TeamRole
  /**
   * Context-level escape hatch for identities that legitimately cross tenants
   * (platform admins, support impersonation). Return true to skip the
   * membership check for this request, e.g.
   * `exempt: ({ user }) => user?.platformAdmin === true`. Prefer this over
   * marking routes `meta.central` when the exemption is about WHO is calling
   * (central disables the guard for everyone on that route).
   */
  exempt?: (context: Record<string, unknown>) => boolean
  /**
   * Opt-in decision cache. Without it every authenticated, tenant-scoped
   * request costs one membership lookup (a single indexed PK read — usually
   * fine). With it, decisions are cached in-process for `ttlMs` and
   * invalidated immediately by the `team:joined` / `team:role_changed` /
   * `team:member_removed` hooks, so same-process changes are always exact;
   * `ttlMs` only bounds staleness for changes made on ANOTHER replica —
   * i.e. a member removed elsewhere may retain access for up to `ttlMs`.
   * Size-bounded by `maxEntries` (default 10_000, oldest evicted).
   */
  cache?: { ttlMs: number; maxEntries?: number }
}

/**
 * Secure-by-default tenant isolation guard. On EVERY authenticated,
 * tenant-scoped request it asserts that `ctx().user` holds a membership in the
 * resolved `ctx().tenant` (rank is only enforced with an explicit `role`) —
 * closing the gap where a tenant is resolved from
 * client-supplied input (`x-tenant-id` header / `Host`) without checking that
 * the caller actually belongs to it.
 *
 * The guard runs only when BOTH a tenant and a user are present (i.e. an
 * authenticated request that resolved a tenant). It is skipped for:
 *  - routes with no resolved tenant (central/platform routes), and
 *  - routes that explicitly opt out with `meta: { central: true }` — used by
 *    the routes that legitimately act across/outside a single tenant
 *    (login, tenant creation, platform admin, invite acceptance).
 *
 * Register it alongside `authPlugin`, `tenancyPlugin` and `teamsPlugin`.
 * Treat tenant *resolution* as identification, never authorization.
 */
export function tenantMembershipPlugin(options: TenantMembershipPluginOptions = {}) {
  const required = options.role
  const cacheKey = (tenantId: string, userId: string): string => `${tenantId}\u0000${userId}`
  const cache = options.cache ? new Map<string, { ok: boolean; until: number }>() : undefined
  const ttlMs = options.cache?.ttlMs ?? 0
  const maxEntries = options.cache?.maxEntries ?? 10_000

  return definePlugin({
    name: 'basalt:teams:membership',
    register({ container, hooks }) {
      const metadata = ensureMetadata(container)

      if (cache) {
        // Precise same-process invalidation: any membership mutation drops the
        // cached decision, so only cross-replica changes wait out the TTL.
        const drop = (tenantId: string, userId: string) => void cache.delete(cacheKey(tenantId, userId))
        hooks.on('team:joined', ({ membership }) => drop(membership.tenantId, membership.userId))
        hooks.on('team:role_changed', ({ membership }) => drop(membership.tenantId, membership.userId))
        hooks.on('team:member_removed', ({ tenantId, userId }) => drop(tenantId, userId))
      }

      const isMember = async (teams: Teams, tenantId: string, userId: string): Promise<boolean> => {
        // Existence by default: a membership guard asks "does a membership
        // record exist?", not "does the role outrank 'member'?" — otherwise a
        // genuine member with a custom role missing from roleRank (rank 0)
        // would be rejected. Rank semantics apply only with an explicit `role`.
        if (required !== undefined) return teams.can(tenantId, userId, required)
        return (await teams.roleOf(tenantId, userId)) !== null
      }

      const guard: RouteGuard = async ({ route, context, container: c }) => {
        if (route.meta?.['central'] === true) return

        const ctxLike = context as { tenant?: { id: string }; user?: { id: string } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        // Only authenticated, tenant-scoped requests are membership-checked.
        if (!tenantId || !userId) return

        // WHO-based escape (platform admin, support) — never cached: the
        // predicate is in-memory and may depend on more than (tenant, user).
        if (options.exempt?.(context as Record<string, unknown>) === true) return

        if (cache) {
          const hit = cache.get(cacheKey(tenantId, userId))
          if (hit && hit.until > Date.now()) {
            if (hit.ok) return
            throw new NotATeamMemberError()
          }
        }

        const ok = await isMember(c.get(TEAMS), tenantId, userId)

        if (cache) {
          // Bounded: evict oldest entries rather than growing without limit.
          while (cache.size >= maxEntries) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
          }
          cache.set(cacheKey(tenantId, userId), { ok, until: Date.now() + ttlMs })
        }

        if (!ok) throw new NotATeamMemberError()
      }
      metadata.add('http:guards', guard)
    },
  })
}
