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
    },
  })
}

export interface TenantMembershipPluginOptions {
  /** Minimum role the user must hold in the resolved tenant. Default: 'member'. */
  role?: TeamRole
}

/**
 * Secure-by-default tenant isolation guard. On EVERY authenticated,
 * tenant-scoped request it asserts that `ctx().user` is a member (or higher) of
 * the resolved `ctx().tenant` — closing the gap where a tenant is resolved from
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
  const required: TeamRole = options.role ?? 'member'
  return definePlugin({
    name: 'basalt:teams:membership',
    register({ container }) {
      const metadata = ensureMetadata(container)
      const guard: RouteGuard = async ({ route, context, container: c }) => {
        if (route.meta?.['central'] === true) return

        const ctxLike = context as { tenant?: { id: string }; user?: { id: string } }
        const tenantId = ctxLike.tenant?.id
        const userId = ctxLike.user?.id
        // Only authenticated, tenant-scoped requests are membership-checked.
        if (!tenantId || !userId) return

        if (!(await c.get(TEAMS).can(tenantId, userId, required))) {
          throw new NotATeamMemberError()
        }
      }
      metadata.add('http:guards', guard)
    },
  })
}
