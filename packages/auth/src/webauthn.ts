import { randomBytes } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'

/**
 * WebAuthn / passkeys ceremony orchestration. The framework owns everything that
 * is NOT cryptography — issuing challenges, assembling the browser options,
 * storing credentials, and the counter/clone check — and delegates the actual
 * attestation/assertion verification to a pluggable {@link WebAuthnVerifier}
 * (implement it over `@simplewebauthn/server` or similar). This keeps the
 * framework free of a crypto dependency while still driving the full flow.
 */

// --- stored credential ----------------------------------------------------

export interface PasskeyCredential {
  /** base64url credential id. */
  id: string
  userId: string
  /** base64url COSE public key (opaque to the framework; the verifier reads it). */
  publicKey: string
  /** Signature counter for clone detection. */
  counter: number
  transports?: string[]
  deviceName?: string
  createdAt: number
  lastUsedAt?: number
}

export interface PasskeyStore {
  add(credential: PasskeyCredential): Promise<void>
  get(credentialId: string): Promise<PasskeyCredential | null>
  forUser(userId: string): Promise<PasskeyCredential[]>
  updateCounter(credentialId: string, counter: number, lastUsedAt: number): Promise<void>
  remove(credentialId: string): Promise<void>
}

export class MemoryPasskeyStore implements PasskeyStore {
  private readonly byId = new Map<string, PasskeyCredential>()
  async add(credential: PasskeyCredential): Promise<void> {
    this.byId.set(credential.id, { ...credential })
  }
  async get(credentialId: string): Promise<PasskeyCredential | null> {
    const found = this.byId.get(credentialId)
    return found ? { ...found } : null
  }
  async forUser(userId: string): Promise<PasskeyCredential[]> {
    return [...this.byId.values()].filter((c) => c.userId === userId).map((c) => ({ ...c }))
  }
  async updateCounter(credentialId: string, counter: number, lastUsedAt: number): Promise<void> {
    const found = this.byId.get(credentialId)
    if (found) {
      found.counter = counter
      found.lastUsedAt = lastUsedAt
    }
  }
  async remove(credentialId: string): Promise<void> {
    this.byId.delete(credentialId)
  }
}

// --- challenge store ------------------------------------------------------

/** A stored challenge plus the subject (user id) it was issued for, if any. */
export interface StoredChallenge {
  challenge: string
  /** The user the registration challenge is bound to — enforced at finish. */
  userId?: string
}

export interface WebAuthnChallengeStore {
  save(key: string, value: StoredChallenge, expiresAt: number): Promise<void>
  /** Return AND consume the challenge (single-use), or null if missing/expired. */
  take(key: string): Promise<StoredChallenge | null>
}

export class MemoryWebAuthnChallengeStore implements WebAuthnChallengeStore {
  private readonly entries = new Map<string, { value: StoredChallenge; expiresAt: number }>()
  private readonly now: () => number
  private readonly maxEntries: number
  constructor(options: { now?: () => number; maxEntries?: number } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxEntries = options.maxEntries ?? 10_000
  }
  async save(key: string, value: StoredChallenge, expiresAt: number): Promise<void> {
    // Purge expired entries so unconsumed challenges cannot accumulate (DoS),
    // and cap total size with FIFO eviction as a hard backstop.
    const now = this.now()
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(k)
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt })
  }
  async take(key: string): Promise<StoredChallenge | null> {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    return entry.expiresAt > this.now() ? entry.value : null
  }
}

// --- the crypto boundary (pluggable) --------------------------------------

export interface VerifyRegistrationInput {
  /** The `RegistrationResponseJSON` from `@simplewebauthn/browser`. */
  response: unknown
  expectedChallenge: string
  expectedOrigin: string | string[]
  expectedRpId: string
  requireUserVerification: boolean
}

export interface VerifiedRegistration {
  verified: boolean
  credential?: {
    id: string
    publicKey: string
    counter: number
    transports?: string[]
  }
}

export interface VerifyAuthenticationInput {
  /** The `AuthenticationResponseJSON` from `@simplewebauthn/browser`. */
  response: unknown
  expectedChallenge: string
  expectedOrigin: string | string[]
  expectedRpId: string
  requireUserVerification: boolean
  credential: { id: string; publicKey: string; counter: number }
}

export interface VerifiedAuthentication {
  verified: boolean
  newCounter: number
}

/** The cryptographic boundary — implement over a WebAuthn library. */
export interface WebAuthnVerifier {
  verifyRegistration(input: VerifyRegistrationInput): Promise<VerifiedRegistration>
  verifyAuthentication(input: VerifyAuthenticationInput): Promise<VerifiedAuthentication>
}

// --- browser options (assembled by the framework, no crypto) --------------

export interface PublicKeyParam {
  type: 'public-key'
  alg: number
}
export interface CredentialDescriptor {
  type: 'public-key'
  id: string
  transports?: string[]
}

export interface RegistrationOptions {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PublicKeyParam[]
  timeout: number
  attestation: 'none'
  excludeCredentials: CredentialDescriptor[]
  authenticatorSelection: { userVerification: string; residentKey: 'preferred' }
}

export interface AuthenticationOptions {
  challenge: string
  timeout: number
  rpId: string
  userVerification: string
  allowCredentials: CredentialDescriptor[]
}

// ES256 and RS256 — the pair virtually every authenticator supports.
const DEFAULT_PUB_KEY_PARAMS: PublicKeyParam[] = [
  { type: 'public-key', alg: -7 },
  { type: 'public-key', alg: -257 },
]

// --- errors ---------------------------------------------------------------

export class WebAuthnChallengeError extends BasaltError {
  readonly status = 400
  constructor() {
    super('WEBAUTHN_CHALLENGE_INVALID', 'No matching WebAuthn challenge — it expired or was already used.')
  }
}
export class WebAuthnVerificationError extends BasaltError {
  readonly status = 400
  constructor() {
    super('WEBAUTHN_VERIFICATION_FAILED', 'The WebAuthn response could not be verified.')
  }
}
export class PasskeyNotFoundError extends BasaltError {
  readonly status = 404
  constructor() {
    super('PASSKEY_NOT_FOUND', 'No passkey matches the presented credential.')
  }
}
export class PasskeyClonedError extends BasaltError {
  readonly status = 401
  constructor() {
    super('PASSKEY_CLONED', 'Signature counter did not increase — the authenticator may be cloned.')
  }
}
export class PasskeyExistsError extends BasaltError {
  readonly status = 409
  constructor() {
    super('PASSKEY_EXISTS', 'This credential is already registered.')
  }
}
export class WebAuthnSubjectMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super(
      'WEBAUTHN_SUBJECT_MISMATCH',
      'The challenge was issued for a different user — refusing to bind the passkey.',
    )
  }
}

// --- the service ----------------------------------------------------------

export interface WebAuthnConfig {
  /** Relying Party ID — your registrable domain, e.g. 'example.com'. */
  rpId: string
  /** Human-readable RP name shown in the OS prompt. */
  rpName: string
  /** Expected origin(s), e.g. 'https://example.com'. */
  origin: string | string[]
  /** Challenge TTL in ms. Default 5 minutes. */
  challengeTtlMs?: number
  /** User-verification requirement. Default 'preferred'. */
  userVerification?: 'required' | 'preferred' | 'discouraged'
  /** Ceremony timeout advertised to the browser, ms. Default 60s. */
  timeoutMs?: number
  /** Override the accepted algorithms. Default ES256 + RS256. */
  pubKeyCredParams?: PublicKeyParam[]
}

export interface WebAuthnServiceOptions {
  config: WebAuthnConfig
  credentials: PasskeyStore
  challenges: WebAuthnChallengeStore
  verifier: WebAuthnVerifier
  now?: () => number
  /** Challenge generator (tests). Default: 32 random bytes, base64url. */
  randomChallenge?: () => string
}

export class WebAuthnService {
  private readonly config: WebAuthnConfig
  private readonly credentials: PasskeyStore
  private readonly challenges: WebAuthnChallengeStore
  private readonly verifier: WebAuthnVerifier
  private readonly now: () => number
  private readonly randomChallenge: () => string

  constructor(options: WebAuthnServiceOptions) {
    this.config = options.config
    this.credentials = options.credentials
    this.challenges = options.challenges
    this.verifier = options.verifier
    this.now = options.now ?? (() => Date.now())
    this.randomChallenge = options.randomChallenge ?? (() => randomBytes(32).toString('base64url'))
  }

  private get uv(): string {
    return this.config.userVerification ?? 'preferred'
  }
  private get timeout(): number {
    return this.config.timeoutMs ?? 60_000
  }
  // Challenges are namespaced per ceremony so a registration and an
  // authentication on the same sessionKey never clobber or cross-consume.
  private challengeKey(kind: 'reg' | 'auth', sessionKey: string): string {
    return `${kind}:${sessionKey}`
  }
  private async issueChallenge(
    kind: 'reg' | 'auth',
    sessionKey: string,
    userId?: string,
  ): Promise<string> {
    const challenge = this.randomChallenge()
    const value: StoredChallenge = userId === undefined ? { challenge } : { challenge, userId }
    await this.challenges.save(
      this.challengeKey(kind, sessionKey),
      value,
      this.now() + (this.config.challengeTtlMs ?? 300_000),
    )
    return challenge
  }

  /** Registration options for a known user; stores the challenge bound to `user.id`. */
  async startRegistration(
    sessionKey: string,
    user: { id: string; name: string; displayName?: string },
  ): Promise<RegistrationOptions> {
    const challenge = await this.issueChallenge('reg', sessionKey, user.id)
    const existing = await this.credentials.forUser(user.id)
    return {
      challenge,
      rp: { id: this.config.rpId, name: this.config.rpName },
      user: { id: user.id, name: user.name, displayName: user.displayName ?? user.name },
      pubKeyCredParams: this.config.pubKeyCredParams ?? DEFAULT_PUB_KEY_PARAMS,
      timeout: this.timeout,
      attestation: 'none',
      excludeCredentials: existing.map((c) => ({
        type: 'public-key',
        id: c.id,
        ...(c.transports ? { transports: c.transports } : {}),
      })),
      authenticatorSelection: { userVerification: this.uv, residentKey: 'preferred' },
    }
  }

  /** Verify a registration response and store the new passkey. Throws on failure. */
  async finishRegistration(
    sessionKey: string,
    userId: string,
    response: unknown,
    deviceName?: string,
  ): Promise<PasskeyCredential> {
    const stored = await this.challenges.take(this.challengeKey('reg', sessionKey))
    if (!stored) throw new WebAuthnChallengeError()
    // The challenge is bound to the user it was issued for; refuse to bind the
    // new passkey to any other account (prevents adding an attacker's
    // authenticator to a victim's account via a caller-supplied userId).
    if (stored.userId !== undefined && stored.userId !== userId) {
      throw new WebAuthnSubjectMismatchError()
    }

    const result = await this.verifier.verifyRegistration({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.config.origin,
      expectedRpId: this.config.rpId,
      requireUserVerification: this.uv === 'required',
    })
    if (!result.verified || !result.credential) throw new WebAuthnVerificationError()

    // Never overwrite an existing credential record (a collided/duplicate
    // credential id must not rebind or clobber another registration).
    if (await this.credentials.get(result.credential.id)) throw new PasskeyExistsError()

    const credential: PasskeyCredential = {
      id: result.credential.id,
      userId,
      publicKey: result.credential.publicKey,
      counter: result.credential.counter,
      ...(result.credential.transports ? { transports: result.credential.transports } : {}),
      ...(deviceName ? { deviceName } : {}),
      createdAt: this.now(),
    }
    await this.credentials.add(credential)
    return credential
  }

  /** Authentication options; `userId` narrows allowCredentials, omit it for discoverable login. */
  async startAuthentication(sessionKey: string, userId?: string): Promise<AuthenticationOptions> {
    const challenge = await this.issueChallenge('auth', sessionKey)
    const creds = userId ? await this.credentials.forUser(userId) : []
    return {
      challenge,
      timeout: this.timeout,
      rpId: this.config.rpId,
      userVerification: this.uv,
      allowCredentials: creds.map((c) => ({
        type: 'public-key',
        id: c.id,
        ...(c.transports ? { transports: c.transports } : {}),
      })),
    }
  }

  /**
   * Verify an authentication response. Looks the credential up by its id, checks
   * the signature counter increased (clone detection), persists the new counter,
   * and returns whose passkey authenticated. Throws on any failure.
   */
  async finishAuthentication(
    sessionKey: string,
    response: unknown,
  ): Promise<{ userId: string; credentialId: string }> {
    const rawId = (response as { id?: unknown })?.id
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > 512) {
      throw new PasskeyNotFoundError()
    }
    const credentialId = rawId

    // Consume the challenge FIRST so a failed lookup still burns the nonce and
    // the endpoint cannot be used as an unauthenticated credential-existence oracle.
    const stored = await this.challenges.take(this.challengeKey('auth', sessionKey))
    if (!stored) throw new WebAuthnChallengeError()

    const credential = await this.credentials.get(credentialId)
    if (!credential) throw new PasskeyNotFoundError()

    const result = await this.verifier.verifyAuthentication({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.config.origin,
      expectedRpId: this.config.rpId,
      requireUserVerification: this.uv === 'required',
      credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter },
    })
    if (!result.verified) throw new WebAuthnVerificationError()

    // Clone detection: a real authenticator's counter strictly increases. Some
    // report 0 forever — only enforce when the stored counter is non-zero.
    if (credential.counter > 0 && result.newCounter <= credential.counter) {
      throw new PasskeyClonedError()
    }
    await this.credentials.updateCounter(credential.id, result.newCounter, this.now())
    return { userId: credential.userId, credentialId: credential.id }
  }

  /** A user's registered passkeys (for a "manage devices" screen). */
  async list(userId: string): Promise<PasskeyCredential[]> {
    return this.credentials.forUser(userId)
  }
  /** Remove a passkey (revoke a device). */
  async remove(credentialId: string): Promise<void> {
    await this.credentials.remove(credentialId)
  }
}
