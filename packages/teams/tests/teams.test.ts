import { describe, expect, it } from 'vitest'
import { createApp } from '@machize/core'
import { FASTIFY, fastifyPlugin } from '@machize/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@machize/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@machize/tenancy'
import {
  LastOwnerError,
  TeamInviteInvalidError,
  Teams,
  TEAMS,
  teamRoutes,
  teamsPlugin,
} from '../src/index.js'

const secret = 'test-secret-value-123456'

describe('Teams service', () => {
  it('invites, accepts, and enrols the user at the invited role', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')

    const { invitation, token } = await teams.invite({ tenantId: 'acme', email: 'bob@acme.test', role: 'member' })
    expect((invitation as { token?: string }).token).toBeUndefined()

    const membership = await teams.accept(token, 'bob1')
    expect(membership).toMatchObject({ tenantId: 'acme', userId: 'bob1', role: 'member' })
    expect(await teams.roleOf('acme', 'bob1')).toBe('member')

    // token is single-use
    await expect(teams.accept(token, 'bob1')).rejects.toBeInstanceOf(TeamInviteInvalidError)
  })

  it('rejects an expired invitation token', async () => {
    let clock = 1_000
    const teams = new Teams({ now: () => clock, inviteTtl: '1h' })
    const { token } = await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    clock += 2 * 60 * 60 * 1000
    await expect(teams.accept(token, 'bob1')).rejects.toBeInstanceOf(TeamInviteInvalidError)
  })

  it('a fresh invite supersedes the previous pending one for the same email', async () => {
    const teams = new Teams()
    const first = await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    expect(await teams.pendingInvites('acme')).toHaveLength(1)
    await expect(teams.accept(first.token, 'bob1')).rejects.toBeInstanceOf(TeamInviteInvalidError)
  })

  it('protects the last owner from demotion and removal', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await expect(teams.changeRole('acme', 'owner1', 'member')).rejects.toBeInstanceOf(LastOwnerError)
    await expect(teams.removeMember('acme', 'owner1')).rejects.toBeInstanceOf(LastOwnerError)

    // a second owner lifts the restriction
    await teams.addMember('acme', 'owner2', 'owner')
    await teams.removeMember('acme', 'owner1')
    expect(await teams.roleOf('acme', 'owner1')).toBeNull()
  })

  it('mirrors role changes into a RoleAssigner (e.g. permissions)', async () => {
    const calls: string[] = []
    const access = {
      async assignRole(u: string, r: string, s: string) {
        calls.push(`assign ${u}:${r}@${s}`)
      },
      async removeRole(u: string, r: string, s: string) {
        calls.push(`remove ${u}:${r}@${s}`)
      },
    }
    const teams = new Teams({ access })
    await teams.addMember('acme', 'owner1', 'owner')
    const { token } = await teams.invite({ tenantId: 'acme', email: 'bob@acme.test', role: 'member' })
    await teams.accept(token, 'bob1')
    await teams.changeRole('acme', 'bob1', 'admin')

    expect(calls).toEqual([
      'assign owner1:owner@acme',
      'assign bob1:member@acme',
      'remove bob1:member@acme',
      'assign bob1:admin@acme',
    ])
  })
})

async function makeApp() {
  const source = new MemoryTenantSource().add({ id: 'acme' })
  const app = await createApp({
    plugins: [
      tenancyPlugin({ source, resolvers: [headerResolver()] }),
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      teamsPlugin(),
      fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY), teams: app.container.get(TEAMS) }
}

const tenant = { 'x-tenant-id': 'acme' }

async function registerAndLogin(server: Awaited<ReturnType<typeof makeApp>>['server'], email: string) {
  await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
  const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
  return { access: login.json().accessToken as string, id: login.json().user.id as string }
}

describe('Team HTTP flow', () => {
  it('owner invites, member accepts, and role guards are enforced', async () => {
    const { app, server, teams } = await makeApp()

    const owner = await registerAndLogin(server, 'owner@acme.test')
    await teams.addMember('acme', owner.id, 'owner')
    const ownerAuth = { authorization: `Bearer ${owner.access}`, ...tenant }

    let inviteToken = ''
    app.hooks.on('team:invited', (p) => {
      inviteToken = (p as { token: string }).token
    })

    // invite (admin+); token is emailed, never in the HTTP body
    const invited = await server.inject({
      method: 'POST',
      url: '/team/invites',
      headers: ownerAuth,
      payload: { email: 'bob@acme.test', role: 'member' },
    })
    expect(invited.statusCode).toBe(201)
    expect((invited.json() as { token?: string }).token).toBeUndefined()
    expect(inviteToken).toBeTruthy()

    // bob accepts
    const bob = await registerAndLogin(server, 'bob@acme.test')
    const accept = await server.inject({
      method: 'POST',
      url: '/team/invites/accept',
      headers: { authorization: `Bearer ${bob.access}`, ...tenant },
      payload: { token: inviteToken },
    })
    expect(accept.statusCode).toBe(200)
    expect(accept.json()).toMatchObject({ userId: bob.id, role: 'member' })

    // members list now has two
    const members = await server.inject({ method: 'GET', url: '/team/members', headers: ownerAuth })
    expect((members.json() as unknown[]).length).toBe(2)

    // bob (member) cannot invite — needs admin
    const denied = await server.inject({
      method: 'POST',
      url: '/team/invites',
      headers: { authorization: `Bearer ${bob.access}`, ...tenant },
      payload: { email: 'carol@acme.test' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error?.code ?? denied.json().code).toBe('TEAM_ROLE_REQUIRED')

    // owner promotes bob to admin
    const promoted = await server.inject({
      method: 'PATCH',
      url: `/team/members/${bob.id}`,
      headers: ownerAuth,
      payload: { role: 'admin' },
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json().role).toBe('admin')

    // owner cannot remove themselves — last owner
    const lastOwner = await server.inject({ method: 'DELETE', url: `/team/members/${owner.id}`, headers: ownerAuth })
    expect(lastOwner.statusCode).toBe(400)
    expect(lastOwner.json().error?.code ?? lastOwner.json().code).toBe('TEAM_LAST_OWNER')

    await app.shutdown()
  })
})
