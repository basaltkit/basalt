import { afterEach, describe, expect, it } from 'vitest'
import { createApp, ctx, type BasaltPlugin } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { route, type BasaltRoute } from '@basaltkit/http'
import { AUTH, MemoryUserSource, authPlugin, authRoutes, mfaRoutes, type PasswordHasher } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { TEAMS, teamRoutes, teamsPlugin, tenantMembershipPlugin, type Teams } from '../src/index.js'

/**
 * BK-014: the recommended composition (tenancy + auth + teamRoutes +
 * tenantMembershipPlugin) must let a NON-member accept an invitation and sign
 * in on the company's tenant, while company data stays members-only.
 */

type AdapterName = 'fastify' | 'express' | 'hono'
type AdapterModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// Express and Hono are not dependencies of @basaltkit/teams: load the workspace
// builds when present (the guard pipeline under test is adapter-neutral).
const load = async (pkg: 'express' | 'hono'): Promise<AdapterModule | null> => {
  try {
    return (await import(new URL(`../../${pkg}/dist/index.js`, import.meta.url).href)) as AdapterModule
  } catch {
    return null
  }
}
const expressModule = await load('express')
const honoModule = await load('hono')
const adapters: AdapterName[] = [
  'fastify',
  ...(expressModule ? (['express'] as const) : []),
  ...(honoModule ? (['hono'] as const) : []),
]

interface Res {
  status: number
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | undefined>
}
interface Harness {
  call(req: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<Res>
  teams: Teams
  auth: import('@basaltkit/auth').Auth
  close(): Promise<void>
}

const parse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return text
  }
}

const fastHasher: PasswordHasher = {
  hash: async (password) => `plain:${password}`,
  verify: async (password, hash) => hash === `plain:${password}`,
}

async function boot(adapter: AdapterName): Promise<Harness> {
  const plugins: BasaltPlugin[] = [
    tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
    authPlugin({ users: new MemoryUserSource(), secret: 'test-secret-test-secret-test-secret', hasher: fastHasher }),
    teamsPlugin(),
    tenantMembershipPlugin(),
  ]
  const routes: BasaltRoute[] = [
    ...authRoutes({ rateLimit: false }),
    ...mfaRoutes(),
    ...teamRoutes(),
    // Company data: any authenticated route of the tenant.
    route({ method: 'GET', url: '/projects', meta: { auth: true }, handler: () => ({ tenant: (ctx() as { tenant?: { id: string } }).tenant?.id }) }),
  ]

  if (adapter === 'fastify') {
    const app = await createApp({ plugins: [...plugins, fastifyPlugin({ routes })] }).boot()
    const server = app.container.get(FASTIFY)
    return {
      teams: app.container.get(TEAMS),
      auth: app.container.get(AUTH),
      async call({ method, url, headers, payload }) {
        const res = await server.inject({
          method: method as 'GET',
          url,
          ...(headers ? { headers } : {}),
          ...(payload !== undefined ? { payload: payload as object } : {}),
        })
        return { status: res.statusCode, body: parse(res.body), headers: res.headers as Res['headers'] }
      },
      close: () => app.shutdown(),
    }
  }
  if (adapter === 'hono') {
    const mod = honoModule!
    const app = await createApp({ plugins: [...plugins, mod['honoPlugin']({ routes })] }).boot()
    const hono = app.container.get(mod['HONO']) as { request(url: string, init: RequestInit): Promise<Response> }
    return {
      teams: app.container.get(TEAMS),
      auth: app.container.get(AUTH),
      async call({ method, url, headers, payload }) {
        const res = await hono.request(`http://localhost${url}`, {
          method,
          headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        })
        return { status: res.status, body: parse(await res.text()), headers: Object.fromEntries(res.headers) }
      },
      close: () => app.shutdown(),
    }
  }
  const mod = expressModule!
  const app = await createApp({ plugins: [...plugins, mod['expressPlugin']({ routes })] }).boot()
  const server = (app.container.get(mod['EXPRESS']) as { listen(port: number, host: string): import('node:http').Server }).listen(
    0,
    '127.0.0.1',
  )
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    teams: app.container.get(TEAMS),
    auth: app.container.get(AUTH),
    async call({ method, url, headers, payload }) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      })
      return { status: res.status, body: parse(await res.text()), headers: Object.fromEntries(res.headers) }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await app.shutdown()
    },
  }
}

const tenant = { 'x-tenant-id': 'acme' }

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

/** Registers + verifies + signs in (without a tenant) — the invitee's own account. */
async function signIn(h: Harness, email: string) {
  await h.call({ method: 'POST', url: '/auth/register', payload: { email, password: 'password123' } })
  const user = await h.auth.users.findByEmail(email)
  await h.auth.users.update!(user!.id, { emailVerified: true })
  const res = await h.call({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } })
  expect(res.status).toBe(200)
  const setCookie = res.headers['set-cookie']
  return {
    id: res.body.user.id as string,
    bearer: { authorization: `Bearer ${res.body.accessToken as string}` },
    refreshToken: res.body.refreshToken as string,
    cookie: String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]!,
  }
}

describe.each(adapters)('tenantMembershipPlugin + account routes (BK-014, %s)', (adapter) => {
  it('a verified non-member accepts an invitation on the company tenant', async () => {
    const h = (harness = await boot(adapter))
    const { token } = await h.teams.invite({ tenantId: 'acme', email: 'new@corp.test', role: 'member' })
    const invitee = await signIn(h, 'new@corp.test')

    const accepted = await h.call({
      method: 'POST',
      url: '/team/invites/accept',
      headers: { ...invitee.bearer, ...tenant },
      payload: { token },
    })
    expect(accepted.status).toBe(200)
    expect(await h.teams.roleOf('acme', invitee.id)).toBe('member')

    // ...and is now a member: company data opens up.
    const projects = await h.call({ method: 'GET', url: '/projects', headers: { ...invitee.bearer, ...tenant } })
    expect(projects.status).toBe(200)
  })

  it('a signed-in non-member can still use the account routes on the company tenant', async () => {
    const h = (harness = await boot(adapter))
    const outsider = await signIn(h, 'out@corp.test')

    const login = await h.call({
      method: 'POST',
      url: '/auth/login',
      headers: { ...outsider.bearer, ...tenant },
      payload: { email: 'out@corp.test', password: 'password123' },
    })
    expect(login.status).toBe(200)

    const loginWithCookie = await h.call({
      method: 'POST',
      url: '/auth/login',
      headers: { cookie: outsider.cookie, ...tenant },
      payload: { email: 'out@corp.test', password: 'password123' },
    })
    expect(loginWithCookie.status).toBe(200)

    expect((await h.call({ method: 'GET', url: '/auth/me', headers: { ...outsider.bearer, ...tenant } })).status).toBe(200)
    expect((await h.call({ method: 'GET', url: '/auth/mfa/status', headers: { ...outsider.bearer, ...tenant } })).status).toBe(200)
    const refresh = await h.call({
      method: 'POST',
      url: '/auth/refresh',
      headers: { ...outsider.bearer, ...tenant },
      payload: { refreshToken: outsider.refreshToken },
    })
    expect(refresh.status).toBe(200)
  })

  it('company data stays members-only for the same non-member', async () => {
    const h = (harness = await boot(adapter))
    const outsider = await signIn(h, 'out@corp.test')
    const projects = await h.call({ method: 'GET', url: '/projects', headers: { ...outsider.bearer, ...tenant } })
    expect(projects.status).toBe(403)
    expect(projects.body.error.code).toBe('TEAM_NOT_A_MEMBER')
    // Tenant-scoped team routes stay guarded too.
    expect((await h.call({ method: 'GET', url: '/team/members', headers: { ...outsider.bearer, ...tenant } })).status).toBe(403)
  })
})
