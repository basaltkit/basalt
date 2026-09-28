import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { AUTH, MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { route } from '@basaltkit/http'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import {
  MemoryInvitationStore,
  MemoryMembershipStore,
  Teams,
  TEAMS,
  canonicalInviteEmail,
  teamsPlugin,
  tenantMembershipPlugin,
  type Invitation,
  type TenantMembershipPluginOptions,
} from '../src/index.js'

const secret = 'test-secret-value-123456'

async function makeApp(teamRole: unknown, membership?: TenantMembershipPluginOptions) {
  const source = new MemoryTenantSource().add({ id: 'acme' })
  const app = await createApp({
    plugins: [
      tenancyPlugin({ source, resolvers: [headerResolver()] }),
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      teamsPlugin({ grantableRoles: ['viewer'] }),
      ...(membership ? [tenantMembershipPlugin(membership)] : []),
      fastifyPlugin({
        routes: [
          ...authRoutes(),
          route({ method: 'GET', url: '/guarded', meta: { auth: true, teamRole: teamRole as string }, handler: () => ({ ok: true }) }),
          route({ method: 'GET', url: '/open', meta: { auth: true }, handler: () => ({ ok: true }) }),
        ],
      }),
    ],
  }).boot()
  const server = app.container.get(FASTIFY)
  const teams = app.container.get(TEAMS)
  const auth = app.container.get(AUTH)
  const login = async (email: string) => {
    await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
    const res = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
    void auth
    return {
      id: res.json().user.id as string,
      headers: { authorization: `Bearer ${res.json().accessToken as string}`, 'x-tenant-id': 'acme' },
    }
  }
  return { app, server, teams, login }
}

const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
  res.json().error?.code ?? res.json().code

describe('FA-044: an unknown / typo role never admits', () => {
  it('can() denies a plain member for "Admin" / "adimn" / "" (they used to rank 0 and pass)', async () => {
    const t = new Teams()
    await t.addMember('acme', 'u1', 'member')
    expect(await t.can('acme', 'u1', 'admin')).toBe(false)
    expect(await t.can('acme', 'u1', 'Admin')).toBe(false)
    expect(await t.can('acme', 'u1', 'adimn')).toBe(false)
    expect(await t.can('acme', 'u1', '')).toBe(false)
    expect(await t.can('acme', 'u1', 'constructor')).toBe(false)
    // an owner does not climb into an unranked role either
    await t.addMember('acme', 'boss', 'owner')
    expect(await t.can('acme', 'boss', 'Admin')).toBe(false)
  })

  it('unranked roles are matched exactly; an unranked member role never satisfies a ranked one', async () => {
    const t = new Teams({ roleRank: { owner: 3, admin: 2, member: 1, guest: 0 }, grantableRoles: ['viewer'] })
    await t.addMember('acme', 'v', 'viewer')
    await t.addMember('acme', 'm', 'member')
    expect(await t.can('acme', 'v', 'viewer')).toBe(true)
    expect(await t.can('acme', 'm', 'viewer')).toBe(false)
    // 'viewer' is unranked (rank 0) — it must not reach a ranked rank-0 role
    expect(await t.can('acme', 'v', 'guest')).toBe(false)
    expect(await t.can('acme', 'm', 'guest')).toBe(true)
  })

  it('meta.teamRole with a typo fails closed (500 TEAM_ROLE_UNKNOWN), never lets a member through', async () => {
    const { app, server, teams, login } = await makeApp('Admin')
    const bob = await login('bob@corp.test')
    await teams.addMember('acme', bob.id, 'member')
    const res = await server.inject({ method: 'GET', url: '/guarded', headers: bob.headers })
    expect(res.statusCode).toBe(500)
    expect(code(res)).toBe('TEAM_ROLE_UNKNOWN')
    await app.shutdown()
  })

  it('meta.teamRole: "" (T-2) is a declared requirement, not an opt-off', async () => {
    const { app, server, teams, login } = await makeApp('')
    const bob = await login('bob@corp.test')
    await teams.addMember('acme', bob.id, 'member')
    const res = await server.inject({ method: 'GET', url: '/guarded', headers: bob.headers })
    expect(res.statusCode).toBe(500)
    expect(code(res)).toBe('TEAM_ROLE_UNKNOWN')
    await app.shutdown()
  })

  it('a non-string meta.teamRole fails closed too; `false` stays an explicit opt-off', async () => {
    const bad = await makeApp(2)
    const u = await bad.login('u@corp.test')
    await bad.teams.addMember('acme', u.id, 'member')
    expect((await bad.server.inject({ method: 'GET', url: '/guarded', headers: u.headers })).statusCode).toBe(500)
    await bad.app.shutdown()

    const off = await makeApp(false)
    const v = await off.login('v@corp.test')
    expect((await off.server.inject({ method: 'GET', url: '/guarded', headers: v.headers })).statusCode).toBe(200)
    await off.app.shutdown()
  })

  it('a known role still enforces rank; a grantable unranked role is exact', async () => {
    const admin = await makeApp('admin')
    const m = await admin.login('m@corp.test')
    await admin.teams.addMember('acme', m.id, 'member')
    expect((await admin.server.inject({ method: 'GET', url: '/guarded', headers: m.headers })).statusCode).toBe(403)
    await admin.teams.changeRole('acme', m.id, 'owner')
    expect((await admin.server.inject({ method: 'GET', url: '/guarded', headers: m.headers })).statusCode).toBe(200)
    await admin.app.shutdown()

    const viewer = await makeApp('viewer')
    const v = await viewer.login('v@corp.test')
    const o = await viewer.login('o@corp.test')
    await viewer.teams.addMember('acme', v.id, 'viewer')
    await viewer.teams.addMember('acme', o.id, 'member')
    expect((await viewer.server.inject({ method: 'GET', url: '/guarded', headers: v.headers })).statusCode).toBe(200)
    expect((await viewer.server.inject({ method: 'GET', url: '/guarded', headers: o.headers })).statusCode).toBe(403)
    await viewer.app.shutdown()
  })

  it('tenantMembershipPlugin({ role }) with a typo fails closed', async () => {
    const { app, server, teams, login } = await makeApp(false, { role: 'Member' })
    const bob = await login('bob@corp.test')
    await teams.addMember('acme', bob.id, 'member')
    const res = await server.inject({ method: 'GET', url: '/open', headers: bob.headers })
    expect(res.statusCode).toBe(500)
    expect(code(res)).toBe('TEAM_ROLE_UNKNOWN')
    await app.shutdown()
  })
})

describe('FA-045: one pending invite per email is case-insensitive', () => {
  it('a member invite to bob@ supersedes an admin invite to Bob@', async () => {
    const t = new Teams()
    await t.invite({ tenantId: 'acme', email: 'Bob@X.test', role: 'admin' })
    await t.invite({ tenantId: 'acme', email: ' bob@x.test', role: 'member' })
    const pending = await t.pendingInvites('acme')
    expect(pending.map((i) => i.role)).toEqual(['member'])
    expect(pending[0]?.email).toBe('bob@x.test')
  })

  it('legacy mixed-case rows (and duplicates of them) are superseded too', async () => {
    const invitations = new MemoryInvitationStore()
    const legacy = (id: string, email: string): Invitation => ({
      id, tenantId: 'acme', email, role: 'admin', token: `h-${id}`, expiresAt: Date.now() + 60_000,
    })
    await invitations.create(legacy('a', 'Bob@X.test'))
    await invitations.create(legacy('b', 'BOB@x.test'))
    await invitations.create(legacy('c', 'alice@x.test'))
    const t = new Teams({ invitations })
    await t.invite({ tenantId: 'acme', email: 'bob@x.test', role: 'member' })
    const pending = await t.pendingInvites('acme')
    expect(pending.map((i) => `${i.email}:${i.role}`).sort()).toEqual(['alice@x.test:admin', 'bob@x.test:member'])
  })

  it('MemoryInvitationStore.findPending compares canonical forms', async () => {
    const s = new MemoryInvitationStore()
    await s.create({ id: 'a', tenantId: 'acme', email: 'Bob@X.test', role: 'member', token: 't', expiresAt: 1 })
    expect((await s.findPending('acme', 'bob@x.test'))?.id).toBe('a')
    expect(canonicalInviteEmail(' Bob@X.Test ')).toBe('bob@x.test')
  })

  it('accept binds to the canonical address (whitespace/case differences still match)', async () => {
    const t = new Teams()
    const { token } = await t.invite({ tenantId: 'acme', email: 'Bob@X.test' })
    expect((await t.accept(token, 'u1', ' BOB@x.test')).role).toBe('member')
  })
})

describe('FA-071 (T-6, T-7): memory stores', () => {
  it('membership keys cannot collide across the tenant/user boundary', async () => {
    const s = new MemoryMembershipStore()
    await s.add({ tenantId: 'a::b', userId: 'c', role: 'owner', createdAt: 1 })
    expect(await s.find('a', 'b::c')).toBeNull()
    await s.add({ tenantId: 'a', userId: 'b::c', role: 'member', createdAt: 2 })
    expect((await s.find('a::b', 'c'))?.role).toBe('owner')
  })

  it('returned records are copies — mutating them does not rewrite the store', async () => {
    const t = new Teams()
    const m = await t.addMember('acme', 'u1', 'member')
    m.role = 'owner'
    for (const listed of await t.members('acme')) listed.role = 'owner'
    expect(await t.roleOf('acme', 'u1')).toBe('member')

    const s = new MemoryInvitationStore()
    const inv: Invitation = { id: 'i', tenantId: 'acme', email: 'x@x.test', role: 'member', token: 't', expiresAt: 1 }
    await s.create(inv)
    inv.role = 'owner'
    const found = await s.findById('i')
    expect(found?.role).toBe('member')
    if (found) found.revokedAt = 5
    expect(await s.listPending('acme')).toHaveLength(1)
  })
})
