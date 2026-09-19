import { describe, expect, it } from 'vitest'
import { HookBus } from '@basaltkit/core'
import {
  Auth,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  MemoryTokenVersionStore,
  MemoryUserSource,
  RefreshInvalidError,
  RefreshReusedError,
  type AuthUser,
  type RefreshRecord,
} from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

const secret = 'x'.repeat(32)

describe('revokeAllTokens is a full logout-everywhere (F22)', () => {
  it('also kills refresh tokens and server-side sessions', async () => {
    const sessions = new MemorySessionStore()
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: fastHasher,
      sessions,
      tokenVersions: new MemoryTokenVersionStore(),
      loginThrottle: false,
    })
    const user = await auth.register('a@x.test', 'password123')
    const { tokens } = await auth.login('a@x.test', 'password123')
    const session = await auth.createSession(user.id)

    await auth.revokeAllTokens(user.id)

    await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)
    expect(await auth.sessionUser(session.id)).toBeNull()
    await expect(auth.verifyAccessToken(tokens.accessToken)).rejects.toThrow()
  })

  it('refresh() refuses a token whose user no longer exists', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret, hasher: fastHasher, loginThrottle: false })
    const user = await auth.register('gone@x.test', 'password123')
    const { tokens } = await auth.login('gone@x.test', 'password123')
    // Simulate account deletion in the app's user table.
    ;(users as unknown as { users: Map<string, AuthUser> }).users.delete(user.id)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)
  })
})

/** A refresh store with latency around each call, to widen the reuse race. */
class SlowRefreshStore extends MemoryRefreshTokenStore {
  delayCreate = 0
  override async create(record: RefreshRecord): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayCreate))
    return super.create(record)
  }
}

describe('refresh reuse race: the winner token does not survive family revocation (F23)', () => {
  it('when the loser revokes the family before the winner stores its new token, the winner is refused', async () => {
    const store = new SlowRefreshStore()
    const hooks = new HookBus()
    const reused: unknown[] = []
    hooks.on('auth:refresh_reused', (p) => void reused.push(p))
    const auth = new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, refreshTokens: store, hooks, loginThrottle: false })
    const user = await auth.register('r@x.test', 'password123')
    const { tokens } = await auth.login('r@x.test', 'password123')

    // Winner's issueTokens create is slow; the loser's revokeFamily lands first.
    store.delayCreate = 30
    const results = await Promise.allSettled([auth.refresh(tokens.refreshToken), auth.refresh(tokens.refreshToken)])
    store.delayCreate = 0

    const winners = results.filter((r): r is PromiseFulfilledResult<{ refreshToken: string; accessToken: string }> => r.status === 'fulfilled')
    for (const w of winners) {
      // Whatever a "winner" got must not be usable after the family was revoked.
      await expect(auth.refresh(w.value.refreshToken)).rejects.toBeTruthy()
    }
    expect(results.some((r) => r.status === 'rejected' && r.reason instanceof RefreshReusedError)).toBe(true)
    expect(reused[0]).toMatchObject({ userId: user.id })
    expect(typeof (reused[0] as { familyId: string }).familyId).toBe('string')
  })
})
