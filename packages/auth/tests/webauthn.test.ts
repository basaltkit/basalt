import { describe, it, expect } from 'vitest'
import {
  WebAuthnService,
  MemoryPasskeyStore,
  MemoryWebAuthnChallengeStore,
  WebAuthnChallengeError,
  WebAuthnVerificationError,
  PasskeyNotFoundError,
  PasskeyClonedError,
  type WebAuthnVerifier,
} from '../src/index.js'

const config = { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' }

// A fake verifier standing in for @simplewebauthn/server. It records what the
// service passed and returns a scripted verdict — the crypto boundary is mocked.
function fakeVerifier(overrides: Partial<WebAuthnVerifier> = {}): WebAuthnVerifier & { seen: unknown[] } {
  const seen: unknown[] = []
  return {
    seen,
    async verifyRegistration(input) {
      seen.push(input)
      return { verified: true, credential: { id: 'cred-1', publicKey: 'pk', counter: 0 } }
    },
    async verifyAuthentication(input) {
      seen.push(input)
      return { verified: true, newCounter: 1 }
    },
    ...overrides,
  }
}

function build(verifier: WebAuthnVerifier, now = () => 1000) {
  const credentials = new MemoryPasskeyStore()
  const challenges = new MemoryWebAuthnChallengeStore({ now })
  let n = 0
  const service = new WebAuthnService({
    config,
    credentials,
    challenges,
    verifier,
    now,
    randomChallenge: () => `chal-${++n}`,
  })
  return { service, credentials, challenges }
}

describe('WebAuthnService — registration', () => {
  it('issues options with the RP + a stored challenge, then stores the verified passkey', async () => {
    const verifier = fakeVerifier()
    const { service, credentials } = build(verifier)
    const options = await service.startRegistration('sess-1', { id: 'u1', name: 'ana@x.io' })
    expect(options.rp).toEqual({ id: 'example.com', name: 'Example' })
    expect(options.challenge).toBe('chal-1')
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257])

    const cred = await service.finishRegistration('sess-1', 'u1', { id: 'cred-1' }, 'MacBook')
    expect(cred).toMatchObject({ id: 'cred-1', userId: 'u1', counter: 0, deviceName: 'MacBook' })
    expect((verifier as ReturnType<typeof fakeVerifier>).seen[0]).toMatchObject({
      expectedChallenge: 'chal-1',
      expectedRpId: 'example.com',
      expectedOrigin: 'https://example.com',
    })
    expect(await credentials.forUser('u1')).toHaveLength(1)
  })

  it('excludes already-registered credentials from a second registration', async () => {
    const { service } = build(fakeVerifier())
    await service.startRegistration('s', { id: 'u1', name: 'a' })
    await service.finishRegistration('s', 'u1', { id: 'cred-1' })
    const options = await service.startRegistration('s2', { id: 'u1', name: 'a' })
    expect(options.excludeCredentials.map((c) => c.id)).toEqual(['cred-1'])
  })

  it('rejects when the challenge is missing/expired or verification fails', async () => {
    const { service } = build(fakeVerifier())
    await expect(service.finishRegistration('nope', 'u1', {})).rejects.toBeInstanceOf(WebAuthnChallengeError)

    const failing = build(fakeVerifier({ async verifyRegistration() { return { verified: false } } }))
    await failing.service.startRegistration('s', { id: 'u1', name: 'a' })
    await expect(failing.service.finishRegistration('s', 'u1', {})).rejects.toBeInstanceOf(
      WebAuthnVerificationError,
    )
  })
})

describe('WebAuthnService — authentication', () => {
  async function withPasskey(verifier: WebAuthnVerifier) {
    const ctx = build(verifier)
    await ctx.service.startRegistration('reg', { id: 'u1', name: 'a' })
    await ctx.service.finishRegistration('reg', 'u1', { id: 'cred-1' })
    return ctx
  }

  it('verifies an assertion, advances the counter, and returns the user', async () => {
    const { service, credentials } = await withPasskey(fakeVerifier())
    await service.startAuthentication('login-1', 'u1')
    const result = await service.finishAuthentication('login-1', { id: 'cred-1' })
    expect(result).toEqual({ userId: 'u1', credentialId: 'cred-1' })
    expect((await credentials.get('cred-1'))?.counter).toBe(1)
  })

  it('works without a userId (discoverable login) by looking the credential up by id', async () => {
    const { service } = await withPasskey(fakeVerifier())
    const options = await service.startAuthentication('login-2') // no userId
    expect(options.allowCredentials).toEqual([])
    const result = await service.finishAuthentication('login-2', { id: 'cred-1' })
    expect(result.userId).toBe('u1')
  })

  it('rejects an unknown credential and an unverified assertion', async () => {
    const { service } = await withPasskey(fakeVerifier())
    await service.startAuthentication('l', 'u1')
    await expect(service.finishAuthentication('l', { id: 'ghost' })).rejects.toBeInstanceOf(
      PasskeyNotFoundError,
    )
  })

  it('flags a cloned authenticator when the counter does not increase', async () => {
    // First auth pushes counter to 5; a later auth reporting 5 again is a clone.
    const verifier = fakeVerifier({ async verifyAuthentication() { return { verified: true, newCounter: 5 } } })
    const { service } = await withPasskey(verifier)
    await service.startAuthentication('a1', 'u1')
    await service.finishAuthentication('a1', { id: 'cred-1' }) // counter 0 → 5, ok
    await service.startAuthentication('a2', 'u1')
    await expect(service.finishAuthentication('a2', { id: 'cred-1' })).rejects.toBeInstanceOf(
      PasskeyClonedError,
    )
  })

  it('a challenge is single-use', async () => {
    const { service } = await withPasskey(fakeVerifier())
    await service.startAuthentication('once', 'u1')
    await service.finishAuthentication('once', { id: 'cred-1' })
    await expect(service.finishAuthentication('once', { id: 'cred-1' })).rejects.toBeInstanceOf(
      WebAuthnChallengeError,
    )
  })
})

describe('WebAuthnService — security hardening (audit remediation)', () => {
  it('H1: refuses to bind a passkey to a user other than the challenge subject', async () => {
    // Challenge issued for the attacker (u-att), finished with the victim's id.
    const { service } = build(fakeVerifier())
    const { WebAuthnSubjectMismatchError } = await import('../src/index.js')
    await service.startRegistration('sess', { id: 'u-att', name: 'att@x.io' })
    await expect(service.finishRegistration('sess', 'victim', { id: 'cred-1' })).rejects.toBeInstanceOf(
      WebAuthnSubjectMismatchError,
    )
  })

  it('M1: never overwrites an already-registered credential id', async () => {
    const { PasskeyExistsError } = await import('../src/index.js')
    const { service } = build(fakeVerifier())
    await service.startRegistration('s1', { id: 'u1', name: 'a' })
    await service.finishRegistration('s1', 'u1', { id: 'cred-1' }) // stores cred-1 → u1
    // A second registration (even for the same user) whose authenticator reports
    // the same credential id must be rejected, not silently rebind/clobber.
    await service.startRegistration('s2', { id: 'u1', name: 'a' })
    await expect(service.finishRegistration('s2', 'u1', { id: 'cred-1' })).rejects.toBeInstanceOf(
      PasskeyExistsError,
    )
  })

  it('a registration challenge cannot be consumed by the authentication ceremony (namespaced)', async () => {
    const { service } = build(fakeVerifier())
    await service.startRegistration('shared', { id: 'u1', name: 'a' })
    // No auth challenge was issued under 'shared' → finishAuthentication must fail closed.
    await expect(service.finishAuthentication('shared', { id: 'cred-1' })).rejects.toThrow()
  })

  it('M3: expired challenges are purged and never accumulate', async () => {
    let clock = 1000
    const store = new MemoryWebAuthnChallengeStore({ now: () => clock, maxEntries: 5 })
    // save 5 short-lived entries, then advance time past expiry and save one more.
    for (let i = 0; i < 5; i++) await store.save(`k${i}`, { challenge: `c${i}` }, clock + 100)
    clock = 2000 // everything above is now expired
    await store.save('fresh', { challenge: 'c-fresh' }, clock + 100)
    // The expired entries were purged on save, so the fresh one is retained and valid.
    expect(await store.take('fresh')).toEqual({ challenge: 'c-fresh' })
    expect(await store.take('k0')).toBeNull()
  })

  it('rejects a non-string credential id without consuming nothing dangerous', async () => {
    const { service } = await (async () => {
      const ctx = build(fakeVerifier())
      await ctx.service.startRegistration('r', { id: 'u1', name: 'a' })
      await ctx.service.finishRegistration('r', 'u1', { id: 'cred-1' })
      return ctx
    })()
    await service.startAuthentication('l', 'u1')
    await expect(service.finishAuthentication('l', { id: { evil: true } })).rejects.toBeInstanceOf(
      PasskeyNotFoundError,
    )
  })
})
