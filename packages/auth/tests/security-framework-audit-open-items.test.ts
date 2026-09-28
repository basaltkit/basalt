import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountLinkConflictError,
  Auth,
  MemoryAccountLinkStore,
  MemoryMfaStore,
  MemoryPasskeyStore,
  MemoryUserSource,
  MemoryWebAuthnChallengeStore,
  OAuth,
  PasskeyClonedError,
  PasskeyStoreOutdatedError,
  SecretBox,
  SecretBoxKeyError,
  SecretUnreadableError,
  SocialLinkRefusedError,
  WebAuthnService,
  totp,
  type OAuthProfile,
  type OAuthProvider,
  type PasskeyStore,
  type WebAuthnVerifier,
} from '../src/index.js'
import { fastHasher } from './helpers/adapters.js'

/**
 * Open items of the framework audit: OAuth account linking by provider subject
 * (FA-058), atomic WebAuthn clone detection (FA-059), and the hardened TOTP
 * secret box (FA-H16 / BK-027).
 */

const secret = 'x'.repeat(32)
const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)

const makeAuth = (extra: Partial<ConstructorParameters<typeof Auth>[0]> = {}) =>
  new Auth({ users: new MemoryUserSource(), secret, hasher: fastHasher, loginThrottle: false, ipLoginThrottle: false, ...extra })

// --- FA-058: account linking by (provider, subject) --------------------------

describe('social login is bound to the provider subject once linked (FA-058)', () => {
  it('an email change at the IdP still reaches the linked account', async () => {
    const accountLinks = new MemoryAccountLinkStore()
    const auth = makeAuth({ accountLinks })
    const first = await auth.socialLogin('ana@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-1' } })
    expect(first.created).toBe(true)
    expect(await accountLinks.find('google', 'g-1')).toMatchObject({ userId: first.user.id, email: 'ana@corp.test' })

    // Same subject, new email — the same account, not a new one.
    const again = await auth.socialLogin('ana.silva@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-1' } })
    expect(again.created).toBe(false)
    expect(again.user.id).toBe(first.user.id)
    expect(await auth.users.findByEmail('ana.silva@corp.test')).toBeNull()
  })

  it('a different subject asserting a linked email is refused (unless explicitly allowed)', async () => {
    const auth = makeAuth()
    const owner = await auth.socialLogin('ana@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-1' } })

    await expect(
      auth.socialLogin('ana@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-2' } }),
    ).rejects.toBeInstanceOf(AccountLinkConflictError)

    const relinked = await auth.socialLogin('ana@corp.test', {
      emailVerified: true,
      identity: { provider: 'google', subject: 'g-2' },
      subjectConflict: 'link',
    })
    expect(relinked.user.id).toBe(owner.user.id)
  })

  it('a first login links an existing account only through a verified email', async () => {
    const accountLinks = new MemoryAccountLinkStore()
    const auth = makeAuth({ accountLinks })
    const user = await auth.register('bob@corp.test', 'password123')
    await expect(
      auth.socialLogin('bob@corp.test', { emailVerified: false, identity: { provider: 'github', subject: '42' } }),
    ).rejects.toBeInstanceOf(SocialLinkRefusedError)
    expect(await accountLinks.find('github', '42')).toBeNull()

    const ok = await auth.socialLogin('bob@corp.test', { emailVerified: true, identity: { provider: 'github', subject: '42' } })
    expect(ok.user.id).toBe(user.id)
    expect((await accountLinks.find('github', '42'))?.userId).toBe(user.id)
  })

  it('adopting an unverified account drops the links its first registrant made', async () => {
    const accountLinks = new MemoryAccountLinkStore()
    const auth = makeAuth({ accountLinks })
    // The attacker creates the account through a provider that does not verify emails.
    const pre = await auth.socialLogin('victim@corp.test', { emailVerified: false, identity: { provider: 'shady', subject: 'attacker' } })
    expect(pre.created).toBe(true)
    // The real owner arrives with a verified email.
    await auth.socialLogin('victim@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'victim' } })
    expect(await accountLinks.find('shady', 'attacker')).toBeNull()
    // The attacker's provider account now starts over: its unverified email cannot link.
    await expect(
      auth.socialLogin('victim@corp.test', { emailVerified: false, identity: { provider: 'shady', subject: 'attacker' } }),
    ).rejects.toBeInstanceOf(SocialLinkRefusedError)
  })

  it('a linked login still requires MFA on an MFA-protected account', async () => {
    const auth = makeAuth({ mfa: new MemoryMfaStore() })
    const first = await auth.socialLogin('m@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-m' } })
    const { secret: totpSecret } = await auth.enrollMfa(first.user.id)
    await auth.activateMfa(first.user.id, totp(totpSecret))
    await expect(
      auth.socialLogin('changed@corp.test', { emailVerified: true, identity: { provider: 'google', subject: 'g-m' } }),
    ).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' })
  })

  it('OAuth.callback passes the provider subject (a second IdP account cannot take the first one\'s place)', async () => {
    let profile: OAuthProfile = { subject: 'sub-1', email: 'dev@corp.test', emailVerified: true }
    const p: OAuthProvider = {
      name: 'idp',
      authorizeUrl: 'https://idp.test/authorize',
      tokenUrl: 'https://idp.test/token',
      clientId: 'cid',
      clientSecret: 'csec',
      scopes: ['email'],
      async fetchProfile() {
        return profile
      },
    }
    const doFetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at' }) })) as unknown as typeof fetch
    const oauth = new OAuth(makeAuth(), [p], { secret, fetch: doFetch })
    const login = async () => {
      const { url, binding } = oauth.authorize('idp', 'https://app/cb')
      const state = new URL(url).searchParams.get('state')!
      return oauth.callback('idp', { code: 'c', state, redirectUri: 'https://app/cb', binding })
    }
    const first = await login()
    profile = { subject: 'sub-1', email: 'renamed@corp.test', emailVerified: true }
    expect((await login()).user.id).toBe(first.user.id)
    profile = { subject: 'sub-2', email: 'dev@corp.test', emailVerified: true }
    await expect(login()).rejects.toBeInstanceOf(AccountLinkConflictError)
  })
})

// --- FA-059: atomic clone detection ------------------------------------------

describe('WebAuthn clone detection is a compare-and-set (FA-059)', () => {
  const config = { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' }

  it('two concurrent assertions presenting the same counter: only one passes', async () => {
    const credentials = new MemoryPasskeyStore()
    await credentials.add({ id: 'cred-1', userId: 'u1', publicKey: 'pk', counter: 5, createdAt: 0 })
    // The verifier yields between the read and the write, as a real one does.
    const verifier: WebAuthnVerifier = {
      async verifyRegistration() {
        return { verified: false }
      },
      async verifyAuthentication() {
        await new Promise((r) => setTimeout(r, 5))
        return { verified: true, newCounter: 6 }
      },
    }
    let n = 0
    const service = new WebAuthnService({
      config,
      credentials,
      challenges: new MemoryWebAuthnChallengeStore(),
      verifier,
      randomChallenge: () => `c-${++n}`,
    })
    await service.startAuthentication('genuine', 'u1')
    await service.startAuthentication('clone', 'u1')
    const results = await Promise.allSettled([
      service.finishAuthentication('genuine', { id: 'cred-1' }),
      service.finishAuthentication('clone', { id: 'cred-1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(PasskeyClonedError)
    expect((await credentials.get('cred-1'))?.counter).toBe(6)
  })

  it('refuses a store without compareAndSetCounter at construction', () => {
    const legacy = {
      add: async () => {},
      get: async () => null,
      forUser: async () => [],
      updateCounter: async () => {},
      remove: async () => {},
    } as unknown as PasskeyStore
    expect(
      () =>
        new WebAuthnService({
          config,
          credentials: legacy,
          challenges: new MemoryWebAuthnChallengeStore(),
          verifier: {} as WebAuthnVerifier,
        }),
    ).toThrow(PasskeyStoreOutdatedError)
  })

  it('MemoryPasskeyStore.compareAndSetCounter writes only on the expected value', async () => {
    const store = new MemoryPasskeyStore()
    await store.add({ id: 'c', userId: 'u', publicKey: 'pk', counter: 1, createdAt: 0 })
    expect(await store.compareAndSetCounter('c', 0, 2, 10)).toBe(false)
    expect(await store.compareAndSetCounter('c', 1, 2, 10)).toBe(true)
    expect(await store.get('c')).toMatchObject({ counter: 2, lastUsedAt: 10 })
    expect(await store.compareAndSetCounter('missing', 0, 1, 10)).toBe(false)
  })
})

// --- FA-H16 / BK-027: the TOTP secret box -----------------------------------

/** The pre-4.0 `v1:` envelope: sha256(key), no AAD. */
function legacyV1(plaintext: string, key: string): string {
  const k = createHash('sha256').update(key).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

describe('TOTP secret box (FA-H16 / BK-027)', () => {
  const ctx = { purpose: 'totp', subject: 'u1' }

  it('a plaintext value written over an encrypted secret is refused (downgrade)', async () => {
    const mfa = new MemoryMfaStore()
    const auth = makeAuth({ mfa, mfaEncryptionKey: KEY_A })
    const user = await auth.register('a@corp.test', 'password123')
    const { secret: real } = await auth.enrollMfa(user.id)
    await auth.activateMfa(user.id, totp(real))

    // Someone with write access to the table swaps in a secret they know.
    const known = 'JBSWY3DPEHPK3PXP'
    const record = (await mfa.get(user.id))!
    await mfa.set(user.id, { ...record, secret: known })
    await expect(auth.verifyMfaCode(user.id, totp(known))).rejects.toBeInstanceOf(SecretUnreadableError)
  })

  it("another user's ciphertext does not open in this user's row (AAD)", async () => {
    const mfa = new MemoryMfaStore()
    const auth = makeAuth({ mfa, mfaEncryptionKey: KEY_A })
    const alice = await auth.register('alice@corp.test', 'password123')
    const mallory = await auth.register('mallory@corp.test', 'password123')
    await auth.enrollMfa(alice.id)
    const { secret: mallorySecret } = await auth.enrollMfa(mallory.id)
    await auth.activateMfa(mallory.id, totp(mallorySecret))
    const aliceRecord = (await mfa.get(alice.id))!
    await mfa.set(alice.id, { ...aliceRecord, enabled: true, secret: (await mfa.get(mallory.id))!.secret })
    await expect(auth.verifyMfaCode(alice.id, totp(mallorySecret))).rejects.toBeInstanceOf(SecretUnreadableError)
  })

  it('envelopes carry a key id; rotation keeps old keys readable and reencryptMfaSecret moves rows over', async () => {
    const mfa = new MemoryMfaStore()
    const old = makeAuth({ mfa, mfaEncryption: { keys: [{ id: 'k1', key: KEY_A }] } })
    const user = await old.register('r@corp.test', 'password123')
    const { secret: totpSecret } = await old.enrollMfa(user.id)
    expect((await mfa.get(user.id))!.secret.startsWith('bka2.k1.')).toBe(true)

    const rotated = makeAuth({ users: old.users, mfa, mfaEncryption: { keys: [{ id: 'k2', key: KEY_B }, { id: 'k1', key: KEY_A }] } })
    expect(await rotated.reencryptMfaSecret(user.id)).toBe('resealed')
    expect((await mfa.get(user.id))!.secret.startsWith('bka2.k2.')).toBe(true)
    expect(await rotated.reencryptMfaSecret(user.id)).toBe('current')
    expect(await rotated.reencryptMfaSecret('nobody')).toBe('none')
    await expect(rotated.activateMfa(user.id, totp(totpSecret))).resolves.toBeDefined()
  })

  it('legacy v1 envelopes and plaintext open only with the explicit opt-in, and migrate', async () => {
    const mfa = new MemoryMfaStore()
    const totpSecret = 'JBSWY3DPEHPK3PXP'
    await mfa.set('u-v1', { secret: legacyV1(totpSecret, 'short-old-key'), enabled: true, recoveryCodes: [] })
    await mfa.set('u-plain', { secret: totpSecret, enabled: true, recoveryCodes: [] })

    const strict = makeAuth({ mfa, mfaEncryptionKey: KEY_A })
    await expect(strict.verifyMfaCode('u-v1', totp(totpSecret))).rejects.toBeInstanceOf(SecretUnreadableError)
    await expect(strict.reencryptMfaSecret('u-plain')).rejects.toBeInstanceOf(SecretUnreadableError)

    const migrating = makeAuth({
      mfa,
      mfaEncryption: { keys: [{ id: 'k1', key: KEY_A }], legacy: { v1Keys: ['short-old-key'], plaintext: true } },
    })
    expect(await migrating.reencryptMfaSecret('u-v1')).toBe('resealed')
    expect(await migrating.reencryptMfaSecret('u-plain')).toBe('resealed')

    // After the migration the strict configuration reads both rows.
    const after = makeAuth({ mfa, mfaEncryption: { keys: [{ id: 'k1', key: KEY_A }] } })
    expect(await after.verifyMfaCode('u-v1', totp(totpSecret))).toBe(true)
  })

  it('the key is derived with HKDF, not a bare sha256, and keys shorter than 32 bytes are refused', () => {
    const box = new SecretBox({ keys: [{ id: 'k', key: KEY_A }] })
    const sealed = box.seal('s3cret', ctx)
    const [, , ivB64, tagB64, ctB64] = sealed.split('.')
    // Decrypting with sha256(key) — the old derivation — fails.
    const sha = createHash('sha256').update(KEY_A).digest()
    expect(() => {
      const d = createDecipheriv('aes-256-gcm', sha, Buffer.from(ivB64!, 'base64url'))
      d.setAuthTag(Buffer.from(tagB64!, 'base64url'))
      Buffer.concat([d.update(Buffer.from(ctB64!, 'base64url')), d.final()])
    }).toThrow()
    expect(box.open(sealed, ctx)).toBe('s3cret')
    expect(() => new SecretBox({ keys: [{ id: 'k', key: 'short' }] })).toThrow(SecretBoxKeyError)
    expect(() => new SecretBox({ keys: [] })).toThrow(SecretBoxKeyError)
    expect(() => new SecretBox({ keys: [{ id: 'k', key: KEY_A }, { id: 'k', key: KEY_B }] })).toThrow(SecretBoxKeyError)
    expect(() => makeAuth({ mfaEncryptionKey: KEY_A, mfaEncryption: { keys: [{ id: 'k', key: KEY_A }] } })).toThrow(SecretBoxKeyError)
  })

  it('a tampered envelope, an unknown key id and a truncated tag are all unreadable', () => {
    const box = new SecretBox({ keys: [{ id: 'k', key: KEY_A }] })
    const sealed = box.seal('s3cret', ctx)
    const parts = sealed.split('.')
    expect(() => box.open(sealed, { purpose: 'totp', subject: 'u2' })).toThrow(SecretUnreadableError)
    expect(() => box.open([parts[0], 'other', ...parts.slice(2)].join('.'), ctx)).toThrow(SecretUnreadableError)
    expect(() => box.open([...parts.slice(0, 3), parts[3]!.slice(0, 8), parts[4]].join('.'), ctx)).toThrow(SecretUnreadableError)
    expect(() => box.open('bka2.k.x', ctx)).toThrow(SecretUnreadableError)
    expect(() => box.open('plain', ctx)).toThrow(SecretUnreadableError)
  })
})
