import { describe, expect, it } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  AccountLockedError,
  Auth,
  LoginThrottle,
  MemoryUserSource,
  MfaAlreadyEnabledError,
  totp,
  type PasswordHasher,
} from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

const secret = 'x'.repeat(32)

/** A hasher whose verify yields to the event loop, like scrypt on the threadpool. */
const slowHasher: PasswordHasher = {
  hash: fastHasher.hash,
  verify: async (password, hash) => {
    await new Promise((r) => setTimeout(r, 5))
    return fastHasher.verify(password, hash)
  },
}

describe('MFA enrollment cannot silently disable an active second factor (F18)', () => {
  it('enrollMfa on an MFA-enabled account is refused and MFA stays on', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, loginThrottle: false })
    const user = await auth.register('ada@acme.test', 'password123')
    const { secret: s } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(s))

    await expect(auth.enrollMfa(user.id)).rejects.toBeInstanceOf(MfaAlreadyEnabledError)
    expect(await auth.mfaStatus(user.id)).toEqual({ enabled: true, pending: false })
    await expect(auth.login('ada@acme.test', 'password123')).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' })
  })
})

describe('login throttling counts attempts before verifying them (F20)', () => {
  it('a parallel burst of wrong passwords gets at most maxAttempts evaluations', async () => {
    let verified = 0
    const counting: PasswordHasher = {
      hash: slowHasher.hash,
      verify: async (p, h) => {
        verified++
        return slowHasher.verify(p, h)
      },
    }
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: counting,
      loginThrottle: new LoginThrottle({ maxAttempts: 5 }),
      ipLoginThrottle: false,
    })
    await auth.register('bob@acme.test', 'the-real-password')
    verified = 0

    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) => auth.login('bob@acme.test', `guess-${i}`)),
    )
    const locked = results.filter((r) => r.status === 'rejected' && r.reason instanceof AccountLockedError).length
    expect(verified).toBeLessThanOrEqual(5)
    expect(locked).toBeGreaterThanOrEqual(55)
  })

  it('a parallel burst of wrong MFA codes is bounded too', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: slowHasher,
      loginThrottle: new LoginThrottle({ maxAttempts: 5 }),
      ipLoginThrottle: false,
    })
    const user = await auth.register('mfa@acme.test', 'pw-correct-1')
    const { secret: s } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(s))

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => auth.login('mfa@acme.test', 'pw-correct-1', String(100000 + i))),
    )
    const invalid = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'AUTH_MFA_INVALID').length
    expect(invalid).toBeLessThanOrEqual(5)
  })

  it('a successful login releases its reservation (normal users are not locked out)', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      loginThrottle: new LoginThrottle({ maxAttempts: 3 }),
      ipLoginThrottle: new LoginThrottle({ maxAttempts: 3 }),
    })
    await auth.register('ok@acme.test', 'password123')
    for (let i = 0; i < 10; i++) {
      await auth.login('ok@acme.test', 'password123', undefined, { ip: '203.0.113.9' })
    }
  })
})

describe('LoginThrottle memory is bounded (F21)', () => {
  it('evicts expired entries and caps the number of tracked identifiers', () => {
    let now = 0
    const throttle = new LoginThrottle({ maxAttempts: 5, windowMs: 1_000, clock: () => now, maxEntries: 100 })
    for (let i = 0; i < 1_000; i++) throttle.recordFailure(`user-${i}@x.test`)
    expect(throttle.size).toBeLessThanOrEqual(100)
    now = 5_000
    throttle.recordFailure('late@x.test')
    expect(throttle.size).toBe(1)
  })

  it('does not retain raw identifiers (keys are hashed to a fixed size)', () => {
    const throttle = new LoginThrottle()
    const huge = `${'a'.repeat(1_000_000)}@x.test`
    throttle.recordFailure(huge)
    expect(throttle.retainedKeyChars()).toBeLessThan(200)
    // Still counts against the same identifier.
    for (let i = 0; i < 4; i++) throttle.recordFailure(huge)
    expect(() => throttle.assertAllowed(huge)).toThrow(AccountLockedError)
  })
})

describe('security events are emitted (F55)', () => {
  it('emits auth:mfa_failed and auth:locked_out without secrets', async () => {
    const hooks = new HookBus()
    const events: Array<[string, unknown]> = []
    hooks.on('auth:mfa_failed', (p) => void events.push(['mfa_failed', p]))
    hooks.on('auth:locked_out', (p) => void events.push(['locked_out', p]))
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      hooks,
      loginThrottle: new LoginThrottle({ maxAttempts: 2 }),
      ipLoginThrottle: false,
    })
    const user = await auth.register('ev@acme.test', 'password123')
    const { secret: s } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(s))

    await expect(auth.login('ev@acme.test', 'password123', '000000')).rejects.toMatchObject({ code: 'AUTH_MFA_INVALID' })
    await expect(auth.login('ev@acme.test', 'wrong')).rejects.toBeTruthy()
    await expect(auth.login('ev@acme.test', 'wrong')).rejects.toBeInstanceOf(AccountLockedError)

    expect(events).toContainEqual(['mfa_failed', { userId: user.id }])
    expect(events).toContainEqual(['locked_out', { email: 'ev@acme.test' }])
    expect(JSON.stringify(events)).not.toContain('000000')
    expect(JSON.stringify(events)).not.toContain('password123')
  })
})
