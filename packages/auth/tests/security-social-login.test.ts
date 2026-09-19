import { describe, expect, it } from 'vitest'
import { HookBus, createApp } from '@basaltkit/core'
import {
  API_KEYS,
  AUTH,
  Auth,
  apiKeysPlugin,
  authPlugin,
  MemoryPasskeyStore,
  webauthnPlugin,
  InvalidCredentialsError,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  MemoryTokenVersionStore,
  MemoryUserSource,
  MfaRequiredError,
  RefreshInvalidError,
  SocialLinkRefusedError,
  totp,
} from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

const secret = 'x'.repeat(32)

const makeAuth = () => {
  const hooks = new HookBus()
  const auth = new Auth({
    users: new MemoryUserSource(),
    secret,
    hasher: fastHasher,
    sessions: new MemorySessionStore(),
    refreshTokens: new MemoryRefreshTokenStore(),
    tokenVersions: new MemoryTokenVersionStore(),
    loginThrottle: false,
    ipLoginThrottle: false,
    hooks,
  })
  return { auth, hooks }
}

describe('social login never links to an existing account by an unverified email (F15)', () => {
  it('refuses to log into an existing account when the provider did not verify the email', async () => {
    const { auth } = makeAuth()
    await auth.register('victim@corp.test', 'password123')
    await expect(auth.socialLogin('victim@corp.test', { emailVerified: false })).rejects.toBeInstanceOf(SocialLinkRefusedError)
    await expect(auth.socialLogin('victim@corp.test')).rejects.toBeInstanceOf(SocialLinkRefusedError)
    // Case variants are the same identity — no bypass through casing.
    await expect(auth.socialLogin('VICTIM@corp.test', { emailVerified: false })).rejects.toBeInstanceOf(SocialLinkRefusedError)
  })

  it('still creates a new account for an unverified email (nothing to take over)', async () => {
    const { auth } = makeAuth()
    const r = await auth.socialLogin('fresh@corp.test', { emailVerified: false })
    expect(r.created).toBe(true)
    expect(r.user.emailVerified).toBe(false)
  })

  it('does not bypass MFA: an MFA-protected account needs the second factor', async () => {
    const { auth } = makeAuth()
    const user = await auth.register('admin@corp.test', 'password123')
    await auth.verifyEmail((await auth.requestEmailVerification('admin@corp.test'))!.token)
    const { secret: totpSecret } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(totpSecret))

    await expect(auth.socialLogin('admin@corp.test', { emailVerified: true })).rejects.toBeInstanceOf(MfaRequiredError)
    const ok = await auth.socialLogin('admin@corp.test', { emailVerified: true, mfaCode: totp(totpSecret) })
    expect(ok.user.id).toBe(user.id)
  })

  it('an explicit mfa: "skip" opt-out is honoured (IdP-enforced MFA)', async () => {
    const { auth } = makeAuth()
    const user = await auth.register('sso@corp.test', 'password123')
    await auth.verifyEmail((await auth.requestEmailVerification('sso@corp.test'))!.token)
    const { secret: totpSecret } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(totpSecret))
    const r = await auth.socialLogin('sso@corp.test', { emailVerified: true, mfa: 'skip' })
    expect(r.user.id).toBe(user.id)
  })
})

describe('verified social login adopting an unverified account revokes the prior credentials (F16)', () => {
  it("the pre-registered password, sessions and refresh tokens stop working", async () => {
    const { auth, hooks } = makeAuth()
    const adopted: string[] = []
    hooks.on('auth:social_account_adopted', ({ user }) => void adopted.push(user.id))

    // Attacker pre-registers the victim's address and keeps a session + refresh token.
    const pre = await auth.register('victim@gmail.test', 'attacker-pass')
    const attacker = await auth.login('victim@gmail.test', 'attacker-pass')
    const session = await auth.createSession(pre.id)

    // Victim signs in with Google (verified email) and gets the same account.
    const victim = await auth.socialLogin('victim@gmail.test', { emailVerified: true })
    expect(victim.user.id).toBe(pre.id)
    expect(victim.user.emailVerified).toBe(true)
    expect(adopted).toEqual([pre.id])

    await expect(auth.login('victim@gmail.test', 'attacker-pass')).rejects.toBeInstanceOf(InvalidCredentialsError)
    await expect(auth.refresh(attacker.tokens.refreshToken)).rejects.toBeInstanceOf(RefreshInvalidError)
    expect(await auth.sessionUser(session.id)).toBeNull()
    await expect(auth.verifyAccessToken(attacker.tokens.accessToken)).rejects.toThrow()
    // The victim's own fresh tokens keep working.
    expect((await auth.verifyAccessToken(victim.tokens.accessToken)).sub).toBe(pre.id)
  })

  it('an attacker-enrolled MFA on the pre-registered account is cleared, not required', async () => {
    const { auth } = makeAuth()
    const pre = await auth.register('victim2@gmail.test', 'attacker-pass')
    const { secret: s } = await auth.enrollMfa(pre.id)
    await auth.activateMfa(pre.id, totp(s))
    const r = await auth.socialLogin('victim2@gmail.test', { emailVerified: true })
    expect(r.user.id).toBe(pre.id)
    expect(await auth.isMfaEnabled(pre.id)).toBe(false)
  })
})

describe('adoption also revokes the credentials that live outside Auth (F16 bypass)', () => {
  // The pre-registered account's owner may have minted API keys and enrolled
  // passkeys before the verified owner showed up — both are login-equivalent.
  it("the pre-registrant's API keys and passkeys stop working", async () => {
    const passkeys = new MemoryPasskeyStore()
    const app = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false }),
        apiKeysPlugin(),
        webauthnPlugin({
          config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
          verifier: {
            verifyRegistration: async () => ({ verified: false }),
            verifyAuthentication: async () => ({ verified: false, newCounter: 0 }),
          },
          credentials: passkeys,
        }),
      ],
    }).boot()
    try {
      const auth = app.container.get(AUTH)
      const keys = app.container.get(API_KEYS)
      const pre = await auth.register('victim3@gmail.test', 'attacker-pass')
      const { key } = await keys.issue({ name: 'backdoor', userId: pre.id })
      await passkeys.add({ id: 'attacker-cred', userId: pre.id, publicKey: 'pk', counter: 0, createdAt: 0 })
      // An unrelated user's key is untouched.
      const other = await auth.register('other@gmail.test', 'password123')
      const { key: otherKey } = await keys.issue({ name: 'ok', userId: other.id })

      const r = await auth.socialLogin('victim3@gmail.test', { emailVerified: true })
      expect(r.user.id).toBe(pre.id)

      expect(await keys.verify(key)).toBeNull()
      expect(await passkeys.forUser(pre.id)).toEqual([])
      expect(await keys.verify(otherKey)).not.toBeNull()
    } finally {
      await app.shutdown()
    }
  })
})
