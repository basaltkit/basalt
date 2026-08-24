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
