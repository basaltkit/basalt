import { ctx, BasaltError, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { TEAMS } from './plugin.js'

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
function userEmail(): string | undefined {
  return (ctx() as { user?: { email?: string } }).user?.email
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
export function teamRoutes(): BasaltRoute[] {
  return [
    route({
      method: 'POST',
      url: '/team/invites',
      meta: { auth: true, teamRole: 'admin' },
      body: z.object({ email: z.string().email(), role: z.string().min(1).optional() }),
      async handler({ body, reply }) {
        const uid = userId()
        const { invitation } = await teams().invite({
          tenantId: tenantId(),
          email: body.email,
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(uid !== undefined ? { invitedBy: uid, actingUserId: uid } : {}),
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
        const uid = userId()
        if (!uid) throw new NoTenantError()
        // Bind to the caller's verified email so a forwarded link can't be
        // redeemed by a different account.
        return teams().accept(body.token, uid, userEmail())
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
        const uid = userId()
        return teams().changeRole(tenantId(), params.userId, body.role, uid !== undefined ? { actingUserId: uid } : {})
      },
    }),

    route({
      method: 'DELETE',
      url: '/team/members/:userId',
      meta: { auth: true, teamRole: 'admin' },
      params: z.object({ userId: z.string() }),
      async handler({ params, reply }) {
        await teams().removeMember(tenantId(), params.userId)
        return reply.code(204).send()
      },
    }),
  ]
}
