import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, METADATA } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { AUTH, MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import {
  InsufficientTeamRoleError,
  LastOwnerError,
  MemoryInvitationStore,
  MemoryMembershipStore,
  NotATeamMemberError,
  TeamInviteInvalidError,
  TeamRoleNotGrantableError,
  Teams,
  TEAMS,
  teamRoutes,
  teamsPlugin,
  tenantMembershipPlugin,
  type TeamRoutesOptions,
} from '../src/index.js'

const secret = 'test-secret-value-123456'
const tenant = { 'x-tenant-id': 'acme' }

async function makeApp(routeOptions?: TeamRoutesOptions) {
  const source = new MemoryTenantSource().add({ id: 'acme' })
  const app = await createApp({
    plugins: [
      tenancyPlugin({ source, resolvers: [headerResolver()] }),
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      teamsPlugin(),
      fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes(routeOptions)] }),
    ],
  }).boot()
  const server = app.container.get(FASTIFY)
  const teams = app.container.get(TEAMS)
  const auth = app.container.get(AUTH)

  const login = async (email: string, opts: { verified?: boolean } = {}) => {
    await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
    const user = await auth.users.findByEmail(email)
    if (opts.verified !== false && user && auth.users.update) await auth.users.update(user.id, { emailVerified: true })
    const res = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
    const id = res.json().user.id as string
    return { id, headers: { authorization: `Bearer ${res.json().accessToken as string}`, ...tenant } }
  }
  return { app, server, teams, login }
}

const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code

describe('F25b: invite acceptance requires a verified email', () => {
  it('an UNVERIFIED account registered at the invitee address cannot redeem the invite', async () => {
    const { app, server, teams, login } = await makeApp()
    const { token } = await teams.invite({ tenantId: 'acme', email: 'victim@corp.test', role: 'admin' })

    const attacker = await login('victim@corp.test', { verified: false })
    const res = await server.inject({
      method: 'POST',
      url: '/team/invites/accept',
      headers: attacker.headers,
      payload: { token },
    })
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('TEAM_EMAIL_NOT_VERIFIED')
    expect(await teams.roleOf('acme', attacker.id)).toBeNull()
    // the invitation stays redeemable by the real (verified) recipient
    expect(await teams.pendingInvites('acme')).toHaveLength(1)
    await app.shutdown()
  })

  it('a verified account at the invitee address still accepts', async () => {
    const { app, server, teams, login } = await makeApp()
    const { token } = await teams.invite({ tenantId: 'acme', email: 'bob@corp.test', role: 'member' })
    const bob = await login('bob@corp.test')
    const res = await server.inject({ method: 'POST', url: '/team/invites/accept', headers: bob.headers, payload: { token } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ userId: bob.id, role: 'member' })
    await app.shutdown()
  })

  it('the explicit requireVerifiedEmail:false opt-out still binds to the invited address', async () => {
    const { app, server, teams, login } = await makeApp({ requireVerifiedEmail: false })
    const { token } = await teams.invite({ tenantId: 'acme', email: 'bob@corp.test', role: 'member' })
    const mallory = await login('mallory@corp.test', { verified: false })
    const denied = await server.inject({ method: 'POST', url: '/team/invites/accept', headers: mallory.headers, payload: { token } })
    expect(denied.statusCode).toBe(400)
    expect(code(denied)).toBe('TEAM_INVITE_INVALID')

    const bob = await login('bob@corp.test', { verified: false })
    const ok = await server.inject({ method: 'POST', url: '/team/invites/accept', headers: bob.headers, payload: { token } })
    expect(ok.statusCode).toBe(200)
    await app.shutdown()
  })
})

describe('F25b: invite acceptance never falls back to an unbound redemption', () => {
  // A custom auth layer (API keys, SSO bridges) may set ctx().user without an
  // email or with a non-boolean emailVerified. Neither may redeem an invite.
  const headerAuth = definePlugin({
    name: 'test:header-auth',
    register({ container }) {
      const metadata = ensureMetadata(container)
      metadata.add('http:guards', async ({ context, request }: { context: Record<string, unknown>; request: { headers: Record<string, unknown> } }) => {
        const raw = request.headers['x-user']
        if (typeof raw === 'string') context['user'] = JSON.parse(raw)
      })
      metadata.add('http:guarded-meta', 'auth')
    },
  })

  it('identities without an email, or with a non-boolean emailVerified, are refused', async () => {
    const source = new MemoryTenantSource().add({ id: 'acme' })
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source, resolvers: [headerResolver()] }),
        headerAuth,
        teamsPlugin(),
        fastifyPlugin({ routes: teamRoutes() }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const teams = app.container.get(TEAMS)
    const { token } = await teams.invite({ tenantId: 'acme', email: 'victim@corp.test', role: 'admin' })
    const send = (user: Record<string, unknown>) =>
      server.inject({
        method: 'POST',
        url: '/team/invites/accept',
        headers: { ...tenant, 'x-user': JSON.stringify(user) },
        payload: { token },
      })

    for (const user of [
      { id: 'x1' }, // no email at all
      { id: 'x2', email: '', emailVerified: true },
      { id: 'x3', email: 'victim@corp.test', emailVerified: 'true' },
      { id: 'x4', email: 'victim@corp.test', emailVerified: 1 },
      { id: 'x5', email: 'victim@corp.test' },
      { id: 'x6', email: 'other@corp.test', emailVerified: true },
    ]) {
      const res = await send(user)
      expect([400, 403]).toContain(res.statusCode)
      expect(await teams.roleOf('acme', user.id as string)).toBeNull()
    }
    const ok = await send({ id: 'real', email: 'Victim@Corp.test', emailVerified: true })
    expect(ok.statusCode).toBe(200)
    await app.shutdown()
  })
})

describe('F40: removeMember enforces the acting user rank', () => {
  it('an admin cannot remove an owner (service)', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'owner2', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    await expect(teams.removeMember('acme', 'owner1', { actingUserId: 'admin1' })).rejects.toBeInstanceOf(
      InsufficientTeamRoleError,
    )
    expect(await teams.roleOf('acme', 'owner1')).toBe('owner')
  })

  it('a non-member actor cannot remove anyone; self-removal and removing lower ranks work', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    await teams.addMember('acme', 'member1', 'member')
    await teams.addMember('acme', 'member2', 'member')
    await expect(teams.removeMember('acme', 'member1', { actingUserId: 'stranger' })).rejects.toBeInstanceOf(
      NotATeamMemberError,
    )
    await teams.removeMember('acme', 'member1', { actingUserId: 'admin1' })
    expect(await teams.roleOf('acme', 'member1')).toBeNull()
    await teams.removeMember('acme', 'member2', { actingUserId: 'member2' }) // leave the team
    expect(await teams.roleOf('acme', 'member2')).toBeNull()
    await teams.removeMember('acme', 'admin1', { actingUserId: 'owner1' })
    expect(await teams.roleOf('acme', 'admin1')).toBeNull()
  })

  it('HTTP: an admin DELETE of an owner is refused (403) and the owner stays', async () => {
    const { app, server, teams, login } = await makeApp()
    const owner = await login('owner@acme.test')
    const owner2 = await login('owner2@acme.test')
    const admin = await login('admin@acme.test')
    await teams.addMember('acme', owner.id, 'owner')
    await teams.addMember('acme', owner2.id, 'owner')
    await teams.addMember('acme', admin.id, 'admin')
    const res = await server.inject({ method: 'DELETE', url: `/team/members/${owner.id}`, headers: admin.headers })
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('TEAM_ROLE_REQUIRED')
    expect(await teams.roleOf('acme', owner.id)).toBe('owner')
    await app.shutdown()
  })
})

describe('F41: roles missing from roleRank are not grantable by an acting user', () => {
  it('an admin cannot self-assign or grant an unranked custom role', async () => {
    const assigned: string[] = []
    const teams = new Teams({
      access: {
        async assignRole(u, r) {
          assigned.push(`${u}:${r}`)
        },
        async removeRole() {},
      },
    })
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    await teams.addMember('acme', 'member1', 'member')

    await expect(
      teams.changeRole('acme', 'admin1', 'billing-admin', { actingUserId: 'admin1' }),
    ).rejects.toBeInstanceOf(TeamRoleNotGrantableError)
    await expect(
      teams.changeRole('acme', 'member1', 'billing-admin', { actingUserId: 'owner1' }),
    ).rejects.toBeInstanceOf(TeamRoleNotGrantableError)
    await expect(
      teams.invite({ tenantId: 'acme', email: 'x@acme.test', role: 'billing-admin', actingUserId: 'admin1' }),
    ).rejects.toBeInstanceOf(TeamRoleNotGrantableError)
    await expect(
      teams.addMember('acme', 'x', 'billing-admin', { actingUserId: 'admin1' }),
    ).rejects.toBeInstanceOf(TeamRoleNotGrantableError)
    // prototype keys are not ranked roles either
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await expect(teams.changeRole('acme', 'member1', role, { actingUserId: 'admin1' })).rejects.toBeInstanceOf(
        TeamRoleNotGrantableError,
      )
    }
    expect(teams.rankOf('constructor')).toBe(0)
    expect(assigned.some((a) => a.includes('billing-admin'))).toBe(false)
    expect(await teams.roleOf('acme', 'admin1')).toBe('admin')
  })

  it('grantableRoles explicitly allows a custom role; trusted server-side calls are unaffected', async () => {
    const teams = new Teams({ grantableRoles: ['viewer'] })
    await teams.addMember('acme', 'admin1', 'admin')
    await teams.addMember('acme', 'member1', 'member')
    await expect(teams.changeRole('acme', 'member1', 'viewer', { actingUserId: 'admin1' })).resolves.toMatchObject({
      role: 'viewer',
    })
    // no actor → trusted seeding path
    await expect(teams.addMember('acme', 'svc', 'billing-admin')).resolves.toMatchObject({ role: 'billing-admin' })
  })

  it('HTTP: PATCH self to an unranked role is refused', async () => {
    const { app, server, teams, login } = await makeApp()
    const owner = await login('owner@acme.test')
    const admin = await login('admin@acme.test')
    await teams.addMember('acme', owner.id, 'owner')
    await teams.addMember('acme', admin.id, 'admin')
    const res = await server.inject({
      method: 'PATCH',
      url: `/team/members/${admin.id}`,
      headers: admin.headers,
      payload: { role: 'billing-admin' },
    })
    expect(res.statusCode).toBe(403)
    expect(code(res)).toBe('TEAM_ROLE_NOT_GRANTABLE')
    const invite = await server.inject({
      method: 'POST',
      url: '/team/invites',
      headers: admin.headers,
      payload: { email: 'x@acme.test', role: 'billing-admin' },
    })
    expect(invite.statusCode).toBe(403)
    expect(await teams.roleOf('acme', admin.id)).toBe('admin')
    await app.shutdown()
  })
})

describe('F42: last-owner rule and invite redemption are race-safe', () => {
  it('concurrent removal and demotion of the two owners never leaves zero owners', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'o1', 'owner')
    await teams.addMember('acme', 'o2', 'owner')
    const results = await Promise.allSettled([
      teams.removeMember('acme', 'o1'),
      teams.changeRole('acme', 'o2', 'member'),
    ])
    const owners = (await teams.members('acme')).filter((m) => m.role === 'owner')
    expect(owners.length).toBeGreaterThanOrEqual(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    for (const r of rejected) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LastOwnerError)
  })

  it('concurrent removal of both owners never leaves zero owners (slow store)', async () => {
    const memberships = new MemoryMembershipStore()
    const tick = () => new Promise((r) => setTimeout(r, 1))
    const slow: typeof memberships = Object.assign(Object.create(memberships) as MemoryMembershipStore, {
      // Read, then yield: models a DB round-trip where the snapshot can be stale.
      list: async (t: string) => {
        const rows = (await memberships.list(t)).map((m) => ({ ...m }))
        await tick()
        return rows
      },
    })
    const teams = new Teams({ memberships: slow })
    await teams.addMember('acme', 'o1', 'owner')
    await teams.addMember('acme', 'o2', 'owner')
    await Promise.allSettled([teams.removeMember('acme', 'o1'), teams.removeMember('acme', 'o2')])
    expect((await teams.members('acme')).filter((m) => m.role === 'owner').length).toBeGreaterThanOrEqual(1)
  })

  it('an invite token can be redeemed only once under concurrency', async () => {
    const invitations = new MemoryInvitationStore()
    const tick = () => new Promise((r) => setTimeout(r, 1))
    // Read, then yield: every concurrent accept sees the same pending snapshot.
    const slow: typeof invitations = Object.assign(Object.create(invitations) as MemoryInvitationStore, {
      findByToken: async (t: string) => {
        const found = await invitations.findByToken(t)
        const row = found ? { ...found } : null
        await tick()
        return row
      },
    })
    const teams = new Teams({ invitations: slow })
    const { token } = await teams.invite({ tenantId: 'acme', email: 'bob@acme.test', role: 'admin' })
    const results = await Promise.allSettled([
      teams.accept(token, 'u1', 'bob@acme.test'),
      teams.accept(token, 'u2', 'bob@acme.test'),
      teams.accept(token, 'u3', 'bob@acme.test'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TeamInviteInvalidError)
    }
    expect((await teams.members('acme')).length).toBe(1)
  })
})

describe('F43: membership cache never re-caches a decision invalidated mid-lookup', () => {
  it('a removal that lands during an in-flight lookup is not overwritten by a stale "member"', async () => {
    type Guard = (info: {
      route: { meta?: Record<string, unknown> }
      context: Record<string, unknown>
      container: unknown
    }) => Promise<void>
    const app = await createApp({
      plugins: [teamsPlugin(), tenantMembershipPlugin({ cache: { ttlMs: 60_000 } })],
    }).boot()
    const teams = app.container.get(TEAMS)
    await teams.addMember('acme', 'm1', 'member')

    // Hold the first lookup open until the removal has been applied.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const originalRoleOf = teams.roleOf.bind(teams)
    let first = true
    teams.roleOf = async (t: string, u: string) => {
      const role = await originalRoleOf(t, u) // read happens BEFORE the removal
      if (first) {
        first = false
        await gate
      }
      return role
    }
    const guards = app.container.get(METADATA).get<Guard>('http:guards')
    const run = () =>
      Promise.all(
        guards.map((g) =>
          g({ route: { meta: {} }, context: { tenant: { id: 'acme' }, user: { id: 'm1' } }, container: app.container }),
        ),
      )

    const inFlight = run()
    await new Promise((r) => setTimeout(r, 5))
    await teams.removeMember('acme', 'm1') // emits team:member_removed → invalidation
    release()
    await inFlight.catch(() => {}) // the in-flight request itself raced the removal

    await expect(run()).rejects.toBeInstanceOf(NotATeamMemberError)
    await app.shutdown()
  })
})

describe('F40/F42 bypass: an upsert or an invite must not overwrite a higher-ranked membership', () => {
  it('addMember with an acting admin cannot overwrite (demote) an owner', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'owner2', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    await expect(teams.addMember('acme', 'owner1', 'member', { actingUserId: 'admin1' })).rejects.toBeInstanceOf(
      InsufficientTeamRoleError,
    )
    expect(await teams.roleOf('acme', 'owner1')).toBe('owner')
  })

  it('a trusted addMember cannot demote the last owner, and the previous role grant is mirrored away', async () => {
    const grants = new Set<string>()
    const teams = new Teams({
      access: {
        assignRole: async (u, r, s) => void grants.add(`${s}:${u}:${r}`),
        removeRole: async (u, r, s) => void grants.delete(`${s}:${u}:${r}`),
      },
    })
    await teams.addMember('acme', 'owner1', 'owner')
    await expect(teams.addMember('acme', 'owner1', 'member')).rejects.toBeInstanceOf(LastOwnerError)
    expect(await teams.roleOf('acme', 'owner1')).toBe('owner')

    await teams.addMember('acme', 'admin1', 'admin')
    await teams.addMember('acme', 'admin1', 'member')
    expect([...grants]).toEqual(['acme:owner1:owner', 'acme:admin1:member'])
  })

  it('accepting a lower-ranked invite never demotes an existing member (not even the sole owner)', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    const { token } = await teams.invite({ tenantId: 'acme', email: 'owner@acme.test', role: 'member', actingUserId: 'admin1' })
    const m = await teams.accept(token, 'owner1', 'owner@acme.test')
    expect(m.role).toBe('owner')
    expect(await teams.roleOf('acme', 'owner1')).toBe('owner')
    // a higher-ranked invite still upgrades
    const up = await teams.invite({ tenantId: 'acme', email: 'm@acme.test', role: 'admin' })
    await teams.addMember('acme', 'm1', 'member')
    expect((await teams.accept(up.token, 'm1', 'm@acme.test')).role).toBe('admin')
  })

  it('HTTP: the sole owner accepting a "member" invite sent by an admin stays owner', async () => {
    const { app, server, teams, login } = await makeApp()
    const owner = await login('owner@acme.test')
    const admin = await login('admin@acme.test')
    await teams.addMember('acme', owner.id, 'owner')
    await teams.addMember('acme', admin.id, 'admin')
    let token = ''
    app.hooks.on('team:invited', (e) => void (token = e.token))
    const inv = await server.inject({
      method: 'POST',
      url: '/team/invites',
      headers: admin.headers,
      payload: { email: 'owner@acme.test', role: 'member' },
    })
    expect(inv.statusCode).toBe(201)
    const res = await server.inject({ method: 'POST', url: '/team/invites/accept', headers: owner.headers, payload: { token } })
    expect(res.statusCode).toBe(200)
    expect(await teams.roleOf('acme', owner.id)).toBe('owner')
    await app.shutdown()
  })
})

describe('F40 bypass: pending invitations do not outlive their inviter authority', () => {
  it('a removed admin cannot re-enter through an invite they sent to an alternate address', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    const { token } = await teams.invite({
      tenantId: 'acme',
      email: 'alt@evil.test',
      role: 'admin',
      invitedBy: 'admin1',
      actingUserId: 'admin1',
    })
    await teams.removeMember('acme', 'admin1', { actingUserId: 'owner1' })
    await expect(teams.accept(token, 'alt', 'alt@evil.test')).rejects.toBeInstanceOf(TeamInviteInvalidError)
    expect(await teams.roleOf('acme', 'alt')).toBeNull()
  })

  it('a demoted admin loses the admin invites they sent, but keeps the ones they could still grant', async () => {
    const teams = new Teams()
    await teams.addMember('acme', 'owner1', 'owner')
    await teams.addMember('acme', 'admin1', 'admin')
    const a = await teams.invite({ tenantId: 'acme', email: 'a@x.test', role: 'admin', invitedBy: 'admin1', actingUserId: 'admin1' })
    const m = await teams.invite({ tenantId: 'acme', email: 'm@x.test', role: 'member', invitedBy: 'admin1', actingUserId: 'admin1' })
    const o = await teams.invite({ tenantId: 'acme', email: 'o@x.test', role: 'admin', invitedBy: 'owner1', actingUserId: 'owner1' })
    await teams.changeRole('acme', 'admin1', 'member', { actingUserId: 'owner1' })
    await expect(teams.accept(a.token, 'u1', 'a@x.test')).rejects.toBeInstanceOf(TeamInviteInvalidError)
    expect((await teams.accept(m.token, 'u2', 'm@x.test')).role).toBe('member')
    expect((await teams.accept(o.token, 'u3', 'o@x.test')).role).toBe('admin')
  })

  it('HTTP: an admin removed after inviting an alt address as admin cannot come back through it', async () => {
    const { app, server, teams, login } = await makeApp()
    const owner = await login('owner@acme.test')
    const admin = await login('admin@acme.test')
    await teams.addMember('acme', owner.id, 'owner')
    await teams.addMember('acme', admin.id, 'admin')
    let token = ''
    app.hooks.on('team:invited', (e) => void (token = e.token))
    await server.inject({ method: 'POST', url: '/team/invites', headers: admin.headers, payload: { email: 'alt@evil.test', role: 'admin' } })
    const del = await server.inject({ method: 'DELETE', url: `/team/members/${admin.id}`, headers: owner.headers })
    expect(del.statusCode).toBe(204)
    const alt = await login('alt@evil.test')
    const res = await server.inject({ method: 'POST', url: '/team/invites/accept', headers: alt.headers, payload: { token } })
    expect(res.statusCode).toBe(400)
    expect(code(res)).toBe('TEAM_INVITE_INVALID')
    expect(await teams.roleOf('acme', alt.id)).toBeNull()
    await app.shutdown()
  })
})
