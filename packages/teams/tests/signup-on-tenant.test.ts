import { afterEach, describe, expect, it } from 'vitest'
import { ctx, definePlugin, type BasaltPlugin } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { AUTH, MemoryUserSource, authPlugin, authRoutes, type RegisterPolicy } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { TEAMS, teamRoutes, teamsInviteGate, teamsPlugin, tenantMembershipPlugin, type Teams } from '../src/index.js'
import { adapters, boot, fastHasher, type Harness } from './helpers/harness.js'

/**
 * BK-033 + BK-044 end to end, on every adapter: a tenant host where
 * registration is invite-only and a verified invitee becomes a member without
 * the invitation link.
 */

const tenant = { 'x-tenant-id': 'acme' }
const password = 'password123'

interface Setup {
  harness: Harness
  users: MemoryUserSource
  teams: Teams
  verifyTokens: Map<string, string>
  refused: Array<{ email: string; tenantId?: string; source: string }>
}

const setup = async (adapter: (typeof adapters)[number]): Promise<Setup> => {
  const users = new MemoryUserSource()
  const verifyTokens = new Map<string, string>()
  const refused: Setup['refused'] = []
  // The teams service is resolved after boot; the policy reads it lazily.
  let teams: Teams | undefined
  const registerPolicy: RegisterPolicy = teamsInviteGate(() => teams!)
  const capture: BasaltPlugin = definePlugin({
    name: 'test:capture',
    register({ hooks }) {
      hooks.on('auth:verify_requested', ({ user, token }) => {
        verifyTokens.set(user.email, token)
      })
      hooks.on('auth:register_refused', (p) => {
        refused.push(p)
      })
    },
  })
  const harness = await boot(
    adapter,
    [
      tenancyPlugin({
        source: new MemoryTenantSource().add({ id: 'acme' }).add({ id: 'globex' }),
        resolvers: [headerResolver()],
      }),
      authPlugin({ users, secret: 'test-secret-test-secret-test-secret', hasher: fastHasher, registerPolicy }),
      teamsPlugin({ acceptOnVerifiedEmail: true }),
      tenantMembershipPlugin(),
      capture,
    ],
    [
      ...authRoutes({ rateLimit: false }),
      ...teamRoutes(),
      route({ method: 'GET', url: '/projects', meta: { auth: true }, handler: () => ({ tenant: (ctx() as { tenant?: { id: string } }).tenant?.id }) }),
    ],
  )
  teams = harness.app.container.get(TEAMS)
  return { harness, users, teams, verifyTokens, refused }
}

const login = async (h: Harness, email: string) => {
  const res = await h.call({ method: 'POST', url: '/auth/login', headers: tenant, payload: { email, password } })
  expect(res.status).toBe(200)
  return res.body.accessToken as string
}

describe.each(adapters)('signup on a tenant host (%s)', (adapter) => {
  let current: Setup | undefined
  afterEach(async () => {
    await current?.harness.close()
    current = undefined
  })

  it('registration is invite-only on the tenant, with identical responses', async () => {
    current = await setup(adapter)
    const { harness: h, users, teams, refused } = current
    await teams.invite({ tenantId: 'acme', email: 'Ana@Acme.test' })

    const stranger = await h.call({ method: 'POST', url: '/auth/register', headers: tenant, payload: { email: 'eve@acme.test', password } })
    const invitee = await h.call({ method: 'POST', url: '/auth/register', headers: tenant, payload: { email: 'ANA@acme.test', password } })
    const apex = await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'founder@else.test', password } })

    expect([stranger.status, invitee.status, apex.status]).toEqual([202, 202, 202])
    expect(stranger.body).toEqual(invitee.body)
    expect(await users.findByEmail('eve@acme.test')).toBeNull()
    expect(await users.findByEmail('ana@acme.test')).not.toBeNull()
    expect(await users.findByEmail('founder@else.test')).not.toBeNull()
    expect(refused).toEqual([{ email: 'eve@acme.test', tenantId: 'acme', source: 'register' }])

    // An invitation to ANOTHER tenant does not open this one.
    await teams.invite({ tenantId: 'globex', email: 'zed@acme.test' })
    await h.call({ method: 'POST', url: '/auth/register', headers: tenant, payload: { email: 'zed@acme.test', password } })
    expect(await users.findByEmail('zed@acme.test')).toBeNull()
  })

  it('invite → register → verify: the invitee is a member without opening the link', async () => {
    current = await setup(adapter)
    const { harness: h, teams, verifyTokens } = current
    await teams.invite({ tenantId: 'acme', email: 'ana@acme.test', role: 'admin' })
    await h.call({ method: 'POST', url: '/auth/register', headers: tenant, payload: { email: 'ana@acme.test', password } })

    // Before verifying: authenticated, but not a member.
    let token = await login(h, 'ana@acme.test')
    let projects = await h.call({ method: 'GET', url: '/projects', headers: { ...tenant, authorization: `Bearer ${token}` } })
    expect(projects.status).toBe(403)

    await h.call({ method: 'POST', url: '/auth/verify/request', headers: tenant, payload: { email: 'ana@acme.test' } })
    const verifyToken = verifyTokens.get('ana@acme.test')
    expect(verifyToken).toBeTruthy()
    const verified = await h.call({ method: 'POST', url: '/auth/verify', headers: tenant, payload: { token: verifyToken } })
    expect(verified.status).toBeLessThan(300)

    token = await login(h, 'ana@acme.test')
    projects = await h.call({ method: 'GET', url: '/projects', headers: { ...tenant, authorization: `Bearer ${token}` } })
    expect(projects.status).toBe(200)
    expect(projects.body).toEqual({ tenant: 'acme' })
    const user = await current.users.findByEmail('ana@acme.test')
    expect(await teams.roleOf('acme', user!.id)).toBe('admin')
    expect(await teams.pendingInvites('acme')).toEqual([])
  })

  it('verified account → invited later → next login enrolls (tenant-scoped)', async () => {
    current = await setup(adapter)
    const { harness: h, teams } = current
    const auth = h.app.container.get(AUTH)
    const bob = await auth.register('bob@acme.test', password, { emailVerified: true })
    await teams.invite({ tenantId: 'acme', email: 'bob@acme.test' })
    await teams.invite({ tenantId: 'globex', email: 'bob@acme.test' })

    await login(h, 'bob@acme.test')
    expect(await teams.roleOf('acme', bob.id)).toBe('member')
    // Signing in to acme never joins globex.
    expect(await teams.roleOf('globex', bob.id)).toBeNull()
    expect(await teams.pendingInvites('globex')).toHaveLength(1)
  })
})
