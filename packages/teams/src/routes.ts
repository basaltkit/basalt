import { ctx, BasaltError, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { TEAMS } from './plugin.js'
import { NotATeamMemberError, TeamInviteInvalidError } from './teams.js'

const teams = () => (ctx().container as Container).get(TEAMS)

/** Current tenant id, read without a hard dependency on @basaltkit/tenancy. */
function tenantId(): string {
  const id = (ctx() as { tenant?: { id: string } }).tenant?.id
  if (!id) throw new NoTenantError()
  return id
}
function userId(): string | undefined {
  return (ctx() as { user?: { id: string } }).user?.id
}
/**
 * The acting user for privileged team routes. Fails closed: without an
 * identity the service would fall back to its trusted (unchecked) mode.
 */
function actingUserId(): string {
  const id = userId()
  if (!id) throw new NotATeamMemberError()
  return id
}
function currentUser(): { email?: unknown; emailVerified?: unknown } | undefined {
  return (ctx() as { user?: { email?: unknown; emailVerified?: unknown } }).user
}

/** Accepting an invite requires the caller's email address to be verified. */
export class TeamEmailNotVerifiedError extends BasaltError {
  readonly status = 403
  constructor() {
    super('TEAM_EMAIL_NOT_VERIFIED', 'Verify your email address before accepting this invitation.')
  }
}

export interface TeamRoutesOptions {
  /**
   * Require `ctx().user.emailVerified === true` to accept an invitation.
   * Default true: acceptance is bound to the invited address, and that binding
   * is only meaningful if the caller proved they own it — otherwise anyone who
   * registers the invitee's address could redeem a leaked link. Set `false`
   * only for apps that verify ownership of the address some other way (the
   * invited-address binding itself still applies).
   */
  requireVerifiedEmail?: boolean
}

class NoTenantError extends BasaltError {
  readonly status = 400
  constructor() {
    super('TEAM_NO_TENANT', 'No tenant in context — team routes require tenancy.')
  }
}
class InviteNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('TEAM_INVITE_NOT_FOUND', 'Invitation not found.')
  }
}

const roleBody = z.object({ role: z.string().min(1) })

/**
 * Team routes: invite / accept / list / revoke invitations, and list / update /
 * remove members. Admin-level actions require `teamRole: 'admin'`; accepting an
 * invite only requires a logged-in user. Invitation tokens are emailed via the
 * `team:invited` hook and never returned over HTTP.
 */
export function teamRoutes(options: TeamRoutesOptions = {}): BasaltRoute[] {
  const requireVerifiedEmail = options.requireVerifiedEmail !== false
  return [
    route({
      method: 'POST',
      url: '/team/invites',
      meta: { auth: true, teamRole: 'admin' },
      body: z.object({ email: z.string().email(), role: z.string().min(1).optional() }),
      async handler({ body, reply }) {
        const uid = actingUserId()
        const { invitation } = await teams().invite({
          tenantId: tenantId(),
          email: body.email,
          ...(body.role !== undefined ? { role: body.role } : {}),
          invitedBy: uid,
          actingUserId: uid,
        })
        return reply.code(201).send(invitation)
      },
    }),

    route({
      method: 'POST',
      url: '/team/invites/accept',
      meta: { auth: true },
      body: z.object({ token: z.string() }),
      async handler({ body }) {
        const uid = actingUserId()
        const user = currentUser()
        // Bind to the caller's email so a forwarded link can't be redeemed by a
        // different account. No email → nothing to bind to → refuse (never fall
        // back to the service's unbound, trusted mode).
        const email = typeof user?.email === 'string' && user.email !== '' ? user.email : undefined
        if (email === undefined) throw new TeamInviteInvalidError()
        // The binding only holds if the caller proved ownership of the address.
        // Checked before the token lookup, so it reveals nothing about the token.
        if (requireVerifiedEmail && user?.emailVerified !== true) throw new TeamEmailNotVerifiedError()
        return teams().accept(body.token, uid, email)
      },
    }),

    route({
      method: 'GET',
      url: '/team/invites',
      meta: { auth: true, teamRole: 'admin' },
      async handler() {
        return teams().pendingInvites(tenantId())
      },
    }),

    route({
      method: 'DELETE',
      url: '/team/invites/:id',
      meta: { auth: true, teamRole: 'admin' },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const invite = await teams().invitation(params.id)
        if (!invite || invite.tenantId !== tenantId()) throw new InviteNotFoundError()
        await teams().revokeInvite(params.id)
        return reply.code(204).send()
      },
    }),

    route({
      method: 'GET',
      url: '/team/members',
      meta: { auth: true, teamRole: 'member' },
      async handler() {
        return teams().members(tenantId())
      },
    }),

    route({
      method: 'PATCH',
      url: '/team/members/:userId',
      meta: { auth: true, teamRole: 'admin' },
      params: z.object({ userId: z.string() }),
      body: roleBody,
      async handler({ params, body }) {
        return teams().changeRole(tenantId(), params.userId, body.role, { actingUserId: actingUserId() })
      },
    }),

    route({
      method: 'DELETE',
      url: '/team/members/:userId',
      meta: { auth: true, teamRole: 'admin' },
      params: z.object({ userId: z.string() }),
      async handler({ params, reply }) {
        await teams().removeMember(tenantId(), params.userId, { actingUserId: actingUserId() })
        return reply.code(204).send()
      },
    }),
  ]
}
