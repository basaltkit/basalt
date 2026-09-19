import { afterEach, describe, expect, it } from 'vitest'
import { HookBus } from '@basaltkit/core'
import { Auth, MemoryUserSource, authPlugin, authRoutes } from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

const secret = 'test-secret-test-secret-test-secret'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('public auth routes ship with a per-route rate limit (F24)', () => {
  it('register, login, password and verification-request routes declare meta.rateLimit by default', () => {
    const routes = authRoutes()
    const limited = routes.filter((r) => r.meta?.['rateLimit']).map((r) => r.url)
    for (const url of ['/auth/register', '/auth/login', '/auth/password/forgot', '/auth/password/reset', '/auth/verify/request']) {
      expect(limited, url).toContain(url)
    }
  })

  it('the default can be overridden or disabled explicitly', () => {
    const custom = authRoutes({ rateLimit: { limit: 3, windowMs: 1_000 } })
    expect(custom.find((r) => r.url === '/auth/login')?.meta?.['rateLimit']).toEqual({ limit: 3, windowMs: 1_000 })
    expect(authRoutes({ rateLimit: false }).some((r) => r.meta?.['rateLimit'])).toBe(false)
  })
})

describe('reset / verification requests are throttled per account (F24)', () => {
  it('flooding forgot-password neither re-mails nor keeps invalidating the live link', async () => {
    const hooks = new HookBus()
    const mailed: string[] = []
    hooks.on('auth:password_reset_requested', ({ token }) => void mailed.push(token))
    const auth = new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, hooks, loginThrottle: false })
    await auth.register('victim@acme.test', 'password123')

    for (let i = 0; i < 50; i++) await auth.requestPasswordReset('victim@acme.test')
    expect(mailed.length).toBeLessThanOrEqual(3)
    // Once the budget is spent, further requests no longer invalidate the most
    // recent link the victim received.
    await expect(auth.resetPassword(mailed.at(-1)!, 'new-password-1')).resolves.toBeTruthy()
  })

  it('verification requests are throttled the same way', async () => {
    const hooks = new HookBus()
    const mailed: string[] = []
    hooks.on('auth:verify_requested', ({ token }) => void mailed.push(token))
    const auth = new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, hooks, loginThrottle: false })
    await auth.register('v@acme.test', 'password123')
    for (let i = 0; i < 50; i++) await auth.requestEmailVerification('v@acme.test')
    expect(mailed.length).toBeLessThanOrEqual(3)
  })
})

describe.each(availableAdapters)('auth route inputs are size-capped (F21) on %s', (adapter) => {
  it('rejects oversized emails and passwords before hashing or throttling them', async () => {
    harness = await boot(
      adapter,
      [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher })],
      authRoutes({ rateLimit: false }),
    )
    const hugeEmail = `${'a'.repeat(300)}@x.test`
    const hugePassword = 'p'.repeat(1_100)
    for (const url of ['/auth/login', '/auth/register']) {
      expect((await harness.call({ method: 'POST', url, payload: { email: hugeEmail, password: 'password123' } })).status, url).toBe(400)
      expect((await harness.call({ method: 'POST', url, payload: { email: 'a@x.test', password: hugePassword } })).status, url).toBe(400)
    }
    for (const url of ['/auth/password/forgot', '/auth/verify/request']) {
      expect((await harness.call({ method: 'POST', url, payload: { email: hugeEmail } })).status, url).toBe(400)
    }
    // A custom password policy is still capped.
    await harness.close()
    harness = await boot(
      adapter,
      [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher })],
      authRoutes({ rateLimit: false, password: { minLength: 12 } }),
    )
    expect((await harness.call({ method: 'POST', url: '/auth/register', payload: { email: 'a@x.test', password: hugePassword } })).status).toBe(400)
  })
})
