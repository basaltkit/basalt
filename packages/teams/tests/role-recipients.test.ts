import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { AUTH, MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import {
  TEAMS,
  Teams,
  TeamUserSourceMissingError,
  teamRoutes,
  teamsPlugin,
  type MemberUser,
  type MemberUserSource,
} from '../src/index.js'

/**
 * BK-022: notifying "every admin of this tenant" must not force an app to read
 * the auth tables directly. `membersWithUsers` batches the lookup in ONE place
 * and `roleRecipients` filters it by the role hierarchy.
 */

/** What a real `@basaltkit/auth` `UserSource` hands back: credentials included. */
interface StoredUser extends MemberUser {
  passwordHash: string
  mfaSecret: string
}

const stored = (id: string, email: string): StoredUser => ({
  id,
  email,
  emailVerified: true,
  passwordHash: `scrypt$${id}`,
  mfaSecret: `TOTPSECRET${id}`,
})

/** A directory that counts lookups, so the fast path is observable. */
function directory(users: StoredUser[], opts: { batched: boolean }) {
  const byId = new Map(users.map((u) => [u.id, u]))
  const calls = { findById: 0, findByIds: 0 }
  const source: MemberUserSource = {
    async findById(id) {
      calls.findById++
      return byId.get(id) ?? null
    },
  }
  if (opts.batched) {
    source.findByIds = async (ids) => {
      calls.findByIds++
      return ids.flatMap((id) => {
        const u = byId.get(id)
        return u ? [u] : []
      })
    }
  }
  return { source, calls }
}

const team = async (source: MemberUserSource | undefined) => {
  const teams = new Teams(source ? { users: source } : {})
  await teams.addMember('acme', 'u-ada', 'owner')
  await teams.addMember('acme', 'u-bob', 'admin')
  await teams.addMember('acme', 'u-cy', 'member')
  // Another tenant entirely — must never appear in acme's listings.
  await teams.addMember('globex', 'u-mallory', 'owner')
  return teams
}

const people = [
  stored('u-ada', 'ada@acme.test'),
  stored('u-bob', 'bob@acme.test'),
  stored('u-cy', 'cy@acme.test'),
  stored('u-mallory', 'mallory@globex.test'),
]

describe('Teams.membersWithUsers', () => {
  it('uses the batched fast path when the source implements findByIds (one call, not N)', async () => {
    const { source, calls } = directory(people, { batched: true })
    const teams = await team(source)

    const members = await teams.membersWithUsers('acme')

    expect(calls.findByIds).toBe(1)
    expect(calls.findById).toBe(0)
    expect(members.map((m) => m.user.email)).toEqual(['ada@acme.test', 'bob@acme.test', 'cy@acme.test'])
  })

  it('falls back to findById when the source has no findByIds', async () => {
    const { source, calls } = directory(people, { batched: false })
    const teams = await team(source)

    const members = await teams.membersWithUsers('acme')

    expect(calls.findById).toBe(3)
    expect(members.map((m) => m.user.email)).toEqual(['ada@acme.test', 'bob@acme.test', 'cy@acme.test'])
  })

  it('keeps the order of the membership listing', async () => {
    for (const batched of [true, false]) {
      const { source } = directory(people, { batched })
      const teams = await team(source)
      const members = await teams.membersWithUsers('acme')
      const memberships = await teams.members('acme')
      expect(members.map((m) => m.userId)).toEqual(memberships.map((m) => m.userId))
      expect(members[0]).toMatchObject({ tenantId: 'acme', userId: 'u-ada', role: 'owner' })
    }
  })

  it('skips a membership whose user account does not exist, on both paths', async () => {
    for (const batched of [true, false]) {
      // Bob's account was deleted (or the invite was never accepted as a real user).
      const { source } = directory(
        people.filter((u) => u.id !== 'u-bob'),
        { batched },
      )
      const teams = await team(source)

      const members = await teams.membersWithUsers('acme')

      expect(members.map((m) => m.userId)).toEqual(['u-ada', 'u-cy'])
      // The membership itself is untouched — only the contact listing skips it.
      expect(await teams.roleOf('acme', 'u-bob')).toBe('admin')
    }
  })

  it('never leaks a password hash, MFA secret or any other stored field', async () => {
    for (const batched of [true, false]) {
      const { source } = directory(people, { batched })
      const teams = await team(source)

      const members = await teams.membersWithUsers('acme')

      for (const m of members) {
        expect(Object.keys(m.user).sort()).toEqual(['email', 'emailVerified', 'id'])
      }
      const serialized = JSON.stringify(members)
      expect(serialized).not.toContain('scrypt$')
      expect(serialized).not.toContain('TOTPSECRET')
      expect(serialized).not.toContain('passwordHash')
      expect(serialized).not.toContain('mfaSecret')
    }
  })

  it('is scoped to the tenant: a member of another tenant never appears', async () => {
    const { source } = directory(people, { batched: true })
    const teams = await team(source)

    const acme = await teams.membersWithUsers('acme')
    expect(acme.map((m) => m.userId)).not.toContain('u-mallory')
    expect(acme.every((m) => m.tenantId === 'acme')).toBe(true)

    const globex = await teams.membersWithUsers('globex')
    expect(globex.map((m) => m.user.email)).toEqual(['mallory@globex.test'])
  })

  it('only asks the directory about ids of this tenant memberships', async () => {
    const asked: string[][] = []
    const teams = await team({
      async findById() {
        return null
      },
      async findByIds(ids) {
        asked.push([...ids])
        return []
      },
    })

    await teams.membersWithUsers('acme')
    expect(asked).toEqual([['u-ada', 'u-bob', 'u-cy']])
  })

  it('ignores a user the directory returns that was not asked for', async () => {
    const teams = await team({
      async findById() {
        return null
      },
      async findByIds() {
        return [{ id: 'u-mallory', email: 'mallory@globex.test' }]
      },
    })
    expect(await teams.membersWithUsers('acme')).toEqual([])
  })

  it('makes no lookup at all for a tenant with no members', async () => {
    const { source, calls } = directory(people, { batched: true })
    const teams = await team(source)
    expect(await teams.membersWithUsers('initech')).toEqual([])
    expect(calls.findByIds).toBe(0)
  })

  it('fails loud when no user source is configured', async () => {
    const teams = await team(undefined)
    await expect(teams.membersWithUsers('acme')).rejects.toBeInstanceOf(TeamUserSourceMissingError)
  })
})

describe('Teams.roleRecipients', () => {
  it('honours the role hierarchy: admins include owners', async () => {
    const { source, calls } = directory(people, { batched: true })
    const teams = await team(source)

    const admins = await teams.roleRecipients('acme', 'admin')

    expect(admins.map((m) => m.user.email)).toEqual(['ada@acme.test', 'bob@acme.test'])
    // A thin filter over membersWithUsers — no extra directory round trip.
    expect(calls.findByIds).toBe(1)
  })

  it('returns everyone for the lowest ranked role and only owners for the highest', async () => {
    const { source } = directory(people, { batched: true })
    const teams = await team(source)

    expect((await teams.roleRecipients('acme', 'member')).map((m) => m.userId)).toEqual(['u-ada', 'u-bob', 'u-cy'])
    expect((await teams.roleRecipients('acme', 'owner')).map((m) => m.userId)).toEqual(['u-ada'])
  })

  it('matches an UNRANKED role exactly — it must not sweep in every rank-0 role', async () => {
    const { source } = directory(
      [...people, stored('u-dee', 'dee@acme.test'), stored('u-eve', 'eve@acme.test')],
      { batched: true },
    )
    const teams = new Teams({ users: source })
    await teams.addMember('acme', 'u-ada', 'owner')
    await teams.addMember('acme', 'u-dee', 'billing-contact')
    await teams.addMember('acme', 'u-eve', 'auditor')

    const billing = await teams.roleRecipients('acme', 'billing-contact')
    expect(billing.map((m) => m.user.email)).toEqual(['dee@acme.test'])
  })

  it('excludes unranked roles from a ranked query', async () => {
    const { source } = directory([...people, stored('u-dee', 'dee@acme.test')], { batched: true })
    const teams = new Teams({ users: source })
    await teams.addMember('acme', 'u-ada', 'owner')
    await teams.addMember('acme', 'u-dee', 'billing-contact')

    expect((await teams.roleRecipients('acme', 'member')).map((m) => m.userId)).toEqual(['u-ada'])
  })

  it('honours a custom roleRank', async () => {
    const { source } = directory(people, { batched: true })
    const teams = new Teams({ users: source, roleRank: { owner: 10, admin: 5, member: 1 } })
    await teams.addMember('acme', 'u-ada', 'owner')
    await teams.addMember('acme', 'u-bob', 'admin')
    await teams.addMember('acme', 'u-cy', 'member')

    expect((await teams.roleRecipients('acme', 'admin')).map((m) => m.userId)).toEqual(['u-ada', 'u-bob'])
  })

  it('exact: true narrows a ranked role to holders of exactly that role', async () => {
    const { source } = directory(people, { batched: true })
    const teams = await team(source)

    const admins = await teams.roleRecipients('acme', 'admin', { exact: true })
    expect(admins.map((m) => m.userId)).toEqual(['u-bob'])
  })

  it('is tenant scoped', async () => {
    const { source } = directory(people, { batched: true })
    const teams = await team(source)
    expect((await teams.roleRecipients('acme', 'owner')).map((m) => m.userId)).toEqual(['u-ada'])
    expect((await teams.roleRecipients('globex', 'owner')).map((m) => m.userId)).toEqual(['u-mallory'])
  })

  it('never leaks credential fields', async () => {
    const { source } = directory(people, { batched: true })
    const teams = await team(source)
    const recipients = await teams.roleRecipients('acme', 'admin')
    expect(JSON.stringify(recipients)).not.toContain('scrypt$')
  })
})

describe('an @basaltkit/auth UserSource drops straight in', () => {
  it('attaches contacts through the auth source without teams importing auth', async () => {
    const users = new MemoryUserSource()
    const ada = await users.create({ email: 'ada@acme.test', passwordHash: 'scrypt$secret' })
    const bob = await users.create({ email: 'bob@acme.test', passwordHash: 'scrypt$secret' })

    const teams = new Teams({ users })
    await teams.addMember('acme', ada.id, 'owner')
    await teams.addMember('acme', bob.id, 'member')

    const owners = await teams.roleRecipients('acme', 'owner')
    expect(owners.map((m) => m.user.email)).toEqual(['ada@acme.test'])
    expect(JSON.stringify(owners)).not.toContain('scrypt$secret')
  })
})

// --- HTTP ---------------------------------------------------------------

const secret = 'test-secret-value-123456'
const tenantHeader = { 'x-tenant-id': 'acme' }

async function makeApp(memberContacts: boolean) {
  const users = new MemoryUserSource()
  const app = await createApp({
    plugins: [
      tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
      authPlugin({ users, secret, loginThrottle: false }),
      teamsPlugin({ users }),
      fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes({ memberContacts })] }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY), teams: app.container.get(TEAMS), auth: app.container.get(AUTH) }
}

type Server = Awaited<ReturnType<typeof makeApp>>['server']

async function login(server: Server, email: string) {
  await server.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
  const res = await server.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
  const body = res.json() as { accessToken: string; user: { id: string } }
  return { access: body.accessToken, id: body.user.id }
}

describe('GET /team/members with memberContacts', () => {
  it('returns contact details when enabled, and never a credential field', async () => {
    const { app, server, teams } = await makeApp(true)
    const owner = await login(server, 'owner@acme.test')
    await teams.addMember('acme', owner.id, 'owner')

    const res = await server.inject({
      method: 'GET',
      url: '/team/members',
      headers: { authorization: `Bearer ${owner.access}`, ...tenantHeader },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({
        tenantId: 'acme',
        userId: owner.id,
        role: 'owner',
        user: { id: owner.id, email: 'owner@acme.test', emailVerified: false },
      }),
    ])
    expect(res.body).not.toContain('passwordHash')
    await app.shutdown()
  })

  it('stays the plain membership listing by default', async () => {
    const { app, server, teams } = await makeApp(false)
    const owner = await login(server, 'owner@acme.test')
    await teams.addMember('acme', owner.id, 'owner')

    const res = await server.inject({
      method: 'GET',
      url: '/team/members',
      headers: { authorization: `Bearer ${owner.access}`, ...tenantHeader },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ user?: unknown }>)[0]?.user).toBeUndefined()
    await app.shutdown()
  })
})
