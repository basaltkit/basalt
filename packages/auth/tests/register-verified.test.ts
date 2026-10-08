import { afterEach, describe, expect, it } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  Auth,
  authPlugin,
  authRoutes,
  MemoryUserSource,
  UserUpdateUnsupportedError,
  type AuthUser,
  type PublicUser,
  type UserSource,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

const SECRET = 'x'.repeat(32)

/** Records the `emailVerified` every `auth:registered` handler observed. */
const recordRegistered = (hooks: HookBus): PublicUser[] => {
  const seen: PublicUser[] = []
  hooks.on('auth:registered', ({ user }) => {
    seen.push({ ...user })
  })
  return seen
}

/** A UserSource written before `create()` took `emailVerified`: it drops the flag. */
class LegacyUserSource implements UserSource {
  readonly inner = new MemoryUserSource()
  findByEmail(email: string) {
    return this.inner.findByEmail(email)
  }
  findById(id: string) {
    return this.inner.findById(id)
  }
  create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    return this.inner.create({ email: data.email, passwordHash: data.passwordHash })
  }
}

describe('register(…, { emailVerified }) — trusted flows (BK-045)', () => {
  it('creates the account verified and auth:registered already reports it', async () => {
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, hooks })

    const user = await auth.register('Owner@Acme.test', 'password123', { emailVerified: true })
    expect(user.emailVerified).toBe(true)
    expect(seen).toEqual([{ id: user.id, email: 'owner@acme.test', emailVerified: true }])
    expect((await users.findById(user.id))?.emailVerified).toBe(true)
  })

  it('defaults to unverified (unchanged behaviour)', async () => {
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, hooks })
    const user = await auth.register('a@b.test', 'password123')
    expect(user.emailVerified).toBe(false)
    expect(seen[0]?.emailVerified).toBe(false)
  })

  it('a legacy UserSource that drops the flag is patched through update()', async () => {
    const legacy = new LegacyUserSource()
    const source: UserSource = Object.assign(legacy, {
      update: (id: string, patch: { emailVerified?: boolean }) => legacy.inner.update(id, patch),
    })
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const auth = new Auth({ users: source, secret: SECRET, hasher: fastHasher, hooks })
    const user = await auth.register('a@b.test', 'password123', { emailVerified: true })
    expect(user.emailVerified).toBe(true)
    expect(seen[0]?.emailVerified).toBe(true)
  })

  it('a legacy UserSource with no update() fails loudly instead of downgrading', async () => {
    const auth = new Auth({ users: new LegacyUserSource(), secret: SECRET, hasher: fastHasher })
    await expect(auth.register('a@b.test', 'password123', { emailVerified: true })).rejects.toBeInstanceOf(
      UserUpdateUnsupportedError,
    )
    // Not requested → no update() needed, exactly as before.
    await expect(auth.register('c@d.test', 'password123')).resolves.toMatchObject({ emailVerified: false })
  })
})

describe('socialLogin creates a provider-verified account verified (BK-045)', () => {
  it('auth:registered sees emailVerified: true', async () => {
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, hooks })
    const { user, created } = await auth.socialLogin('sso@acme.test', { emailVerified: true })
    expect(created).toBe(true)
    expect(user.emailVerified).toBe(true)
    expect(seen).toEqual([{ id: user.id, email: 'sso@acme.test', emailVerified: true }])
  })

  it('an unverified provider email still creates an unverified account', async () => {
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET, hasher: fastHasher, hooks })
    const { user } = await auth.socialLogin('sso@acme.test', { emailVerified: false })
    expect(user.emailVerified).toBe(false)
    expect(seen[0]?.emailVerified).toBe(false)
  })
})

/**
 * W13: a first social login must never leave a half-created account behind.
 * Each UserSource shape: full (memory), honours the flag without update(),
 * drops the flag without update() (legacy custom), and a transient update()
 * failure after the row exists.
 */
describe('socialLogin never orphans the account it creates (W13)', () => {
  const identity = { provider: 'google', subject: 'sub-1' }

  it('memory source: created verified, linked, later logins reach the same account', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher })
    const first = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(first).toMatchObject({ created: true, user: { emailVerified: true } })
    const again = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(again).toMatchObject({ created: false, user: { id: first.user.id, emailVerified: true } })
  })

  it('custom source without update() that honours create({ emailVerified }) is verified', async () => {
    const inner = new MemoryUserSource()
    const users: UserSource = {
      findByEmail: (e) => inner.findByEmail(e),
      findById: (id) => inner.findById(id),
      create: (data) => inner.create(data),
    }
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher })
    const { user } = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(user.emailVerified).toBe(true)
  })

  it('custom source without update() that drops the flag: no 500, no orphan, no lockout', async () => {
    const hooks = new HookBus()
    const seen = recordRegistered(hooks)
    const users = new LegacyUserSource()
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher, hooks })

    const first = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    // The source cannot record verification: the account says so truthfully.
    expect(first).toMatchObject({ created: true, user: { emailVerified: false } })
    expect(seen).toEqual([{ id: first.user.id, email: 'sso@acme.test', emailVerified: false }])
    // Every later login reaches the same account through the link.
    for (let i = 0; i < 3; i++) {
      const again = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
      expect(again).toMatchObject({ created: false, user: { id: first.user.id } })
    }
  })

  it('a transient update() failure after create: the retried login succeeds', async () => {
    const inner = new MemoryUserSource()
    let failNext = true
    const users: UserSource = {
      findByEmail: (e) => inner.findByEmail(e),
      findById: (id) => inner.findById(id),
      // Drops the flag, so the verification goes through update().
      create: (data) => inner.create({ email: data.email, passwordHash: data.passwordHash }),
      update: async (id, patch) => {
        if (failNext) {
          failNext = false
          throw new Error('db down')
        }
        return inner.update(id, patch)
      },
    }
    const auth = new Auth({ users, secret: SECRET, hasher: fastHasher })
    await expect(auth.socialLogin('sso@acme.test', { emailVerified: true, identity })).rejects.toThrow('db down')
    const retry = await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })
    expect(retry.user.emailVerified).toBe(true)
    expect(await auth.socialLogin('sso@acme.test', { emailVerified: true, identity })).toMatchObject({
      user: { id: retry.user.id, emailVerified: true },
    })
  })
})

describe.each(availableAdapters)('POST /auth/register never creates a verified account (%s)', (adapter) => {
  let harness: Harness | undefined
  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('ignores an emailVerified field in the body', async () => {
    const users = new MemoryUserSource()
    harness = await boot(adapter, [authPlugin({ users, secret: SECRET, hasher: fastHasher })], authRoutes())
    const res = await harness.call({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'eve@acme.test', password: 'password123', emailVerified: true },
    })
    expect(res.status).toBe(202)
    expect((await users.findByEmail('eve@acme.test'))?.emailVerified).toBe(false)
  })
})
