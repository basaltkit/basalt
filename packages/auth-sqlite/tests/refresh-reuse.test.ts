import { Auth, MemoryUserSource, RefreshReusedError } from '@basaltkit/auth'
import { describe, expect, it } from 'vitest'
import { sqliteAuthStores } from '../src/index.js'

const newAuth = () => {
  const stores = sqliteAuthStores(':memory:')
  const auth = new Auth({
    secret: 'test-secret-test-secret-test-secret',
    users: new MemoryUserSource(),
    sessions: stores.sessions,
    tokens: stores.tokens,
    refreshTokens: stores.refreshTokens,
  })
  return { auth, stores }
}

describe('F-1 · refresh reuse detection is atomic', () => {
  it('two concurrent refreshes of the same token: exactly one wins', async () => {
    const { auth } = newAuth()
    await auth.register('a@b.com', 'correct-horse-battery')
    const { tokens } = await auth.login('a@b.com', 'correct-horse-battery')

    const results = await Promise.allSettled([
      auth.refresh(tokens.refreshToken),
      auth.refresh(tokens.refreshToken),
    ])

    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(RefreshReusedError)
  })

  it('the losing refresh revokes the family, so the winner is dead too', async () => {
    const { auth } = newAuth()
    await auth.register('a@b.com', 'correct-horse-battery')
    const { tokens } = await auth.login('a@b.com', 'correct-horse-battery')

    const results = await Promise.allSettled([
      auth.refresh(tokens.refreshToken),
      auth.refresh(tokens.refreshToken),
    ])
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      refreshToken: string
    }>

    await expect(auth.refresh(winner.value.refreshToken)).rejects.toThrow()
  })

  it('markUsed reports whether THIS call consumed the token', async () => {
    const { stores } = newAuth()
    await stores.refreshTokens.create({
      token: 'tok',
      userId: 'u1',
      familyId: 'f1',
      expiresAt: Date.now() + 60_000,
    })

    expect(await stores.refreshTokens.markUsed('tok')).toBe(true)
    expect(await stores.refreshTokens.markUsed('tok')).toBe(false)
  })

  it('single-use auth tokens (reset/verify) are consumed atomically too', async () => {
    const { stores } = newAuth()
    await stores.tokens.create({
      token: 'tok',
      userId: 'u1',
      purpose: 'reset_password',
      expiresAt: Date.now() + 60_000,
    })

    expect(await stores.tokens.markUsed('tok')).toBe(true)
    expect(await stores.tokens.markUsed('tok')).toBe(false)
  })
})
