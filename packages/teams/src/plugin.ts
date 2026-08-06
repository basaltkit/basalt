import { createToken, definePlugin, ensureMetadata } from '@machize/core'
import type { RouteGuard } from '@machize/fastify'
import { InsufficientTeamRoleError, NotATeamMemberError, Teams, type TeamsOptions } from './teams.js'
import type { Membership, PublicInvitation, TeamRole } from './stores.js'

declare module '@machize/core' {
  interface MachizeHooks {
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
    name: 'machize:teams',
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
