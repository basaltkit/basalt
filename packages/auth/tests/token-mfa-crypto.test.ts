import { describe, expect, it } from 'vitest'
import {
  Auth,
  AuthTokenInvalidError,
  MemoryMfaStore,
  MemoryTokenVersionStore,
  MemoryUserSource,
  totp,
} from '../src/index.js'

const SECRET = 'x'.repeat(32)

describe('TOTP secret encryption at rest (M-3)', () => {
  it('stores the secret as an encrypted envelope but still verifies codes', async () => {
    const mfa = new MemoryMfaStore()
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      mfa,
      mfaEncryptionKey: 'an-app-held-mfa-key',
    })
    const user = await auth.register('a@b.c', 'password123')
    const { secret } = await auth.enrollMfa(user.id)

    const stored = (await mfa.get(user.id))!.secret
    expect(stored.startsWith('v1:')).toBe(true) // ciphertext envelope
    expect(stored).not.toContain(secret) // plaintext secret is not on disk

    // Decryption on the verify path still works end-to-end.
    await expect(auth.activateMfa(user.id, totp(secret))).resolves.toBeDefined()
  })

  it('reads back legacy plaintext secrets (gradual migration)', async () => {
    const mfa = new MemoryMfaStore()
    const key = 'an-app-held-mfa-key'
    // Simulate a pre-encryption record: plaintext secret already on disk.
    const plain = new Auth({ users: new MemoryUserSource(), secret: SECRET, mfa })
    const user = await plain.register('a@b.c', 'password123')
    const { secret } = await plain.enrollMfa(user.id)

    // A key-configured Auth still verifies the legacy plaintext record.
    const encAuth = new Auth({ users: plain.users, secret: SECRET, mfa, mfaEncryptionKey: key })
    await expect(encAuth.activateMfa(user.id, totp(secret))).resolves.toBeDefined()
  })
})

describe('access-token revocation (M-5)', () => {
  it('rejects an access token once the version is bumped, accepts freshly-issued ones', async () => {
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret: SECRET,
      tokenVersions: new MemoryTokenVersionStore(),
    })
    const user = await auth.register('a@b.c', 'password123')
    const { tokens } = await auth.login('a@b.c', 'password123')

    expect((await auth.verifyAccessToken(tokens.accessToken)).sub).toBe(user.id)

    await auth.revokeAllTokens(user.id) // e.g. what resetPassword does

    await expect(auth.verifyAccessToken(tokens.accessToken)).rejects.toBeInstanceOf(AuthTokenInvalidError)

    const fresh = await auth.login('a@b.c', 'password123')
    expect((await auth.verifyAccessToken(fresh.tokens.accessToken)).sub).toBe(user.id)
  })

  it('is a no-op without a TokenVersionStore (back-compat)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    await auth.register('a@b.c', 'password123')
    const { tokens } = await auth.login('a@b.c', 'password123')
    await auth.revokeAllTokens('anyone')
    expect((await auth.verifyAccessToken(tokens.accessToken)).sub).toBeTruthy()
  })
})

describe('recovery-code entropy (L-1)', () => {
  it('issues 80-bit recovery codes (20 hex chars)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const user = await auth.register('a@b.c', 'password123')
    const { secret } = await auth.enrollMfa(user.id)
    const { recoveryCodes } = await auth.activateMfa(user.id, totp(secret))
    expect(recoveryCodes).toHaveLength(10)
    expect(recoveryCodes[0]!.replace(/-/g, '')).toMatch(/^[0-9a-f]{20}$/)
  })
})
