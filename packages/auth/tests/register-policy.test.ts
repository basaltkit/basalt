import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, ensureMetadata, HookBus, runWithContext, type BasaltPlugin } from '@basaltkit/core'
import type { RequestEnricher } from '@basaltkit/http'
import {
  Auth,
  authPlugin,
  authRoutes,
  MemoryUserSource,
  RegistrationClosedError,
  type AuthRoutesOptions,
  type RegisterPolicy,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

const SECRET = 'x'.repeat(32)

/** Stand-in for @basaltkit/tenancy: resolves ctx().tenant from `x-tenant-id`. */
const headerTenancy = (): BasaltPlugin =>
  definePlugin({
    name: 'test:tenancy',
    register({ container }) {
      const enricher: RequestEnricher = ({ request, context }) => {
        const id = request.headers['x-tenant-id']
        if (typeof id === 'string') (context as { tenant?: { id: string } }).tenant = { id }
      }
      ensureMetadata(container).add('http:enrichers', enricher)
    },
  })

/** Apex open; on a tenant only the invited (canonical) addresses. */
const invited = new Map<string, Set<string>>([['acme', new Set(['ana@acme.test'])]])
const inviteOnly: RegisterPolicy = ({ email, tenantId }) =>
  tenantId === undefined || (invited.get(tenantId)?.has(email) ?? false)

type Refused = { email: string; tenantId?: string; source: 'register' | 'social' }

describe('Auth registration policy (BK-044)', () => {
  it('registerSafely: a refusal creates nothing, resolves like a success and emits auth:register_refused', async () => {
    const hooks = new HookBus()
    const refused: Refused[] = []
    hooks.on('auth:register_refused', (p) => {
      refused.push(p)
    })
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, hooks, registerPolicy: inviteOnly })

    await expect(auth.registerSafely('eve@acme.test', 'password123', { tenantId: 'acme' })).resolves.toBeUndefined()
    expect(await users.findByEmail('eve@acme.test')).toBeNull()
    expect(refused).toEqual([{ email: 'eve@acme.test', tenantId: 'acme', source: 'register' }])

    // The policy sees the canonical email.
    await auth.registerSafely('  ANA@Acme.TEST ', 'password123', { tenantId: 'acme' })
    expect(await users.findByEmail('ana@acme.test')).not.toBeNull()

    // Apex: open.
    await auth.registerSafely('anyone@else.test', 'password123')
    expect(await users.findByEmail('anyone@else.test')).not.toBeNull()
  })

  it('registerSafely reads the tenant from the request context', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, registerPolicy: inviteOnly })
    await runWithContext({ tenant: { id: 'acme' } }, () => auth.registerSafely('eve@acme.test', 'password123'))
    expect(await users.findByEmail('eve@acme.test')).toBeNull()
  })

  it('opts.policy overrides the default; null means open', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, registerPolicy: () => false })
    await auth.registerSafely('a@b.test', 'password123', { policy: null })
    expect(await users.findByEmail('a@b.test')).not.toBeNull()
  })

  it('a refused existing email does not emit auth:register_existing_email', async () => {
    const hooks = new HookBus()
    const existing: string[] = []
    hooks.on('auth:register_existing_email', ({ email }) => {
      existing.push(email)
    })
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, hooks })
    await auth.register('eve@acme.test', 'password123')
    await auth.registerSafely('eve@acme.test', 'password123', { policy: () => false })
    expect(existing).toEqual([])
  })

  it('a throwing policy fails the request (fail closed)', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({
      users,
      secret: SECRET,
      hasher: fastHasher,
      registerPolicy: () => {
        throw new Error('store down')
      },
    })
    await expect(auth.registerSafely('a@b.test', 'password123')).rejects.toThrow('store down')
    expect(await users.findByEmail('a@b.test')).toBeNull()
  })

  it('register() (trusted) is never gated', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, registerPolicy: () => false })
    await expect(auth.register('a@b.test', 'password123')).resolves.toMatchObject({ email: 'a@b.test' })
  })

  it('socialLogin: refuses to CREATE on a tenant without an invite, with RegistrationClosedError', async () => {
    const hooks = new HookBus()
    const refused: Refused[] = []
    hooks.on('auth:register_refused', (p) => {
      refused.push(p)
    })
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, hooks, registerPolicy: inviteOnly })

    await expect(auth.socialLogin('eve@acme.test', { emailVerified: true, tenantId: 'acme' })).rejects.toBeInstanceOf(
      RegistrationClosedError,
    )
    expect(await users.findByEmail('eve@acme.test')).toBeNull()
    expect(refused).toEqual([{ email: 'eve@acme.test', tenantId: 'acme', source: 'social' }])

    // From the request context too.
    await expect(
      runWithContext({ tenant: { id: 'acme' } }, () => auth.socialLogin('eve@acme.test', { emailVerified: true })),
    ).rejects.toBeInstanceOf(RegistrationClosedError)

    // Invited: created.
    const ok = await auth.socialLogin('ana@acme.test', { emailVerified: true, tenantId: 'acme' })
    expect(ok.created).toBe(true)
  })

  it('socialLogin into an EXISTING account is never gated', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, registerPolicy: () => false })
    await auth.register('bob@acme.test', 'password123', { emailVerified: true })
    const res = await auth.socialLogin('bob@acme.test', { emailVerified: true, tenantId: 'acme' })
    expect(res.created).toBe(false)
  })
})

describe.each(availableAdapters)('POST /auth/register with a registration policy (%s)', (adapter) => {
  let harness: Harness | undefined
  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  const setup = async (routeOptions: AuthRoutesOptions, users = new MemoryUserSource()) => {
    const refused: Refused[] = []
    const capture = definePlugin({
      name: 'test:capture',
      register({ hooks }) {
        hooks.on('auth:register_refused', (p) => {
          refused.push(p)
        })
      },
    })
    harness = await boot(
      adapter,
      [headerTenancy(), authPlugin({ users, secret: SECRET, hasher: fastHasher }), capture],
      authRoutes(routeOptions),
    )
    return { users, refused, harness }
  }

  it('a predicate refusal answers the same 202 as a success, creates nothing, emits the hook', async () => {
    const { users, refused, harness: h } = await setup({ register: inviteOnly })

    const noInvite = await h.call({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-tenant-id': 'acme' },
      payload: { email: 'eve@acme.test', password: 'password123' },
    })
    const invitedRes = await h.call({
      method: 'POST',
      url: '/auth/register',
      headers: { 'x-tenant-id': 'acme' },
      payload: { email: 'Ana@Acme.test', password: 'password123' },
    })
    const apex = await h.call({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'founder@else.test', password: 'password123' },
    })

    // Identical responses: the gate is not an oracle for who was invited.
    expect(noInvite.status).toBe(202)
    expect(invitedRes.status).toBe(202)
    expect(apex.status).toBe(202)
    expect(noInvite.body).toEqual(invitedRes.body)

    expect(await users.findByEmail('eve@acme.test')).toBeNull()
    expect(await users.findByEmail('ana@acme.test')).not.toBeNull()
    expect(await users.findByEmail('founder@else.test')).not.toBeNull()
    expect(refused).toEqual([{ email: 'eve@acme.test', tenantId: 'acme', source: 'register' }])
  })

  it("'closed' answers a static 404 AUTH_REGISTRATION_CLOSED, even to a malformed body", async () => {
    const { users, harness: h } = await setup({ register: 'closed' })
    const res = await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.test', password: 'password123' } })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('AUTH_REGISTRATION_CLOSED')
    expect(await users.findByEmail('a@b.test')).toBeNull()

    const junk = await h.call({ method: 'POST', url: '/auth/register', payload: { nope: 1 } })
    expect(junk.status).toBe(404)
    expect(junk.body.error.code).toBe('AUTH_REGISTRATION_CLOSED')
  })

  it("'open' ignores the plugin-level registerPolicy", async () => {
    const users = new MemoryUserSource()
    harness = await boot(
      adapter,
      [headerTenancy(), authPlugin({ users, secret: SECRET, hasher: fastHasher, registerPolicy: () => false })],
      authRoutes({ register: 'open' }),
    )
    await harness.call({ method: 'POST', url: '/auth/register', headers: { 'x-tenant-id': 'acme' }, payload: { email: 'a@b.test', password: 'password123' } })
    expect(await users.findByEmail('a@b.test')).not.toBeNull()
  })

  it('without a route option the plugin-level registerPolicy applies', async () => {
    const users = new MemoryUserSource()
    harness = await boot(
      adapter,
      [headerTenancy(), authPlugin({ users, secret: SECRET, hasher: fastHasher, registerPolicy: inviteOnly })],
      authRoutes(),
    )
    const res = await harness.call({ method: 'POST', url: '/auth/register', headers: { 'x-tenant-id': 'acme' }, payload: { email: 'eve@acme.test', password: 'password123' } })
    expect(res.status).toBe(202)
    expect(await users.findByEmail('eve@acme.test')).toBeNull()
  })
})
