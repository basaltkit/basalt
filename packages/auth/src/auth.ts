import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { BasaltError, isProductionEnvironment, parseDuration, tryCtx, type DurationInput, type HookBus } from '@basaltkit/core'
import { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
import { LoginThrottle, type ThrottleStore } from './throttle.js'
import { signJwt, verifyJwt, type JwtClaims } from './jwt.js'
import { generateTotpSecret, matchTotpStep, otpauthUri } from './totp.js'
import { SecretBox, SecretBoxKeyError, type SecretBoxKey, type SecretBoxLegacyOptions } from './secret-box.js'
import {
  MemoryAccountLinkStore,
  MemoryAuthTokenStore,
  MemoryMfaStore,
  MemoryRefreshTokenStore,
  MemorySessionStore,
  type AccountLinkStore,
  type AuthTokenPurpose,
  type AuthTokenStore,
  type AuthUser,
  type MfaStore,
  type PublicUser,
  type RefreshTokenStore,
  type SessionRecord,
  type SessionStore,
  type TokenVersionStore,
  type UserPatch,
  type UserSource,
} from './stores.js'

export class InvalidCredentialsError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.')
  }
}

export class EmailTakenError extends BasaltError {
  readonly status = 409
  constructor() {
    super('AUTH_EMAIL_TAKEN', 'An account with this email already exists.')
  }
}

/**
 * Thrown at construction when the JWT signing secret is missing or too weak. A
 * short/low-entropy HS256 key can be brute-forced offline, letting an attacker
 * forge access tokens for any account — so this fails closed rather than boot
 * with a guessable key. Use `@basaltkit/env`'s `secret({ minLength: 32 })`.
 */
export class WeakJwtSecretError extends BasaltError {
  constructor(reason: string) {
    super('AUTH_WEAK_SECRET', `The auth signing secret is ${reason}. Set a strong APP_SECRET (>= 32 chars).`)
  }
}

export class RefreshInvalidError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_INVALID', 'The refresh token is invalid or expired.')
  }
}

/** A used refresh token came back — the whole family is revoked. */
export class RefreshReusedError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REFRESH_REUSED', 'Refresh token reuse detected. All sessions of this family were revoked.')
  }
}

export class AuthRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

/** A verification / reset token was unknown, already used, or expired. */
export class AuthTokenInvalidError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_TOKEN_INVALID', 'The link is invalid or has expired. Request a new one.')
  }
}

/** The configured UserSource can't be updated (needed for verification/reset). */
export class UserUpdateUnsupportedError extends BasaltError {
  readonly status = 500
  constructor() {
    super('AUTH_UPDATE_UNSUPPORTED', 'The UserSource does not implement update() — required for this flow.')
  }
}

/** Credentials were correct but the account has MFA — a code is required. */
export class MfaRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_MFA_REQUIRED', 'A multi-factor authentication code is required.')
  }
}

/**
 * The route needs a credential obtained with a second factor (MFA policy or
 * `meta.mfa: true`), and the account has MFA enabled: sign in again with a
 * code. Distinct from the 401 {@link MfaRequiredError} of the login itself.
 */
export class MfaStepUpRequiredError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_MFA_REQUIRED', 'This action requires a sign-in with multi-factor authentication. Sign in again with your code.')
  }
}

/**
 * The route needs a credential obtained with a second factor, and the account
 * has not enabled MFA yet: enrol (`/auth/mfa/enroll` + `/activate`), then sign
 * in again with a code.
 */
export class MfaEnrollmentRequiredError extends BasaltError {
  readonly status = 403
  constructor() {
    super('AUTH_MFA_ENROLLMENT_REQUIRED', 'Multi-factor authentication is required for this account. Enable it, then sign in again.')
  }
}

/** The supplied MFA (or recovery) code was wrong. */
export class MfaInvalidCodeError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_MFA_INVALID', 'The authentication code is incorrect.')
  }
}

/** MFA is already active: re-enrolling would silently switch it off. Disable it (with a code) first. */
export class MfaAlreadyEnabledError extends BasaltError {
  readonly status = 409
  constructor() {
    super('AUTH_MFA_ALREADY_ENABLED', 'MFA is already enabled. Disable it with a valid code before enrolling again.')
  }
}

/**
 * A social / SSO login matched an existing account by email, but the provider
 * did not vouch for that email (unverified), so linking would let anyone who
 * can create an IdP account with the address take the account over.
 */
export class SocialLinkRefusedError extends BasaltError {
  readonly status = 403
  constructor() {
    super(
      'AUTH_SOCIAL_LINK_REFUSED',
      'An account with this email already exists and the identity provider did not verify the email. Sign in with your password instead.',
    )
  }
}

/**
 * A social / SSO login's provider account conflicts with an existing link: the
 * local account is already linked to a different subject of the same provider
 * (another IdP account asserting the same email), or the subject was bound to
 * another account concurrently.
 */
export class AccountLinkConflictError extends BasaltError {
  readonly status = 409
  constructor() {
    super(
      'AUTH_ACCOUNT_LINK_CONFLICT',
      'This account is linked to a different identity at this provider. Sign in with that identity or with your password.',
    )
  }
}

/**
 * A user store holds more than one account whose email differs only in letter
 * case (rows written before emails were canonicalised), so an email lookup
 * cannot tell which account is meant. Stores throw it instead of guessing:
 * resolve the duplicates (e.g. `normalizeAuthUserEmails()` of
 * `@basaltkit/auth-prisma` / `@basaltkit/auth-sqlite` reports them), then the
 * lookup works again. Not exposed to the client.
 */
export class AccountEmailAmbiguousError extends BasaltError {
  readonly status = 500
  readonly expose = false
  constructor(email: string) {
    super(
      'AUTH_EMAIL_AMBIGUOUS',
      `More than one account matches the email "${email}" in different letter cases; merge or rename the duplicates.`,
    )
  }
}

/** A provider name / subject usable as a link key part: non-empty, bounded, no NUL. */
const isLinkPart = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0')

/**
 * Canonical form of an email identity: trimmed and lowercased. Every lookup,
 * create and throttle key goes through it, so `Bob@acme.test` and
 * `bob@acme.test` are one account.
 */
export const canonicalEmail = (email: string): string => email.trim().toLowerCase()

/**
 * Account creation is not open here: the register route is configured
 * `register: 'closed'`, or a {@link RegisterPolicy} refused a social / SSO
 * login that would have created a new account. (A policy refusing the public
 * register route never surfaces this — that route answers the same 202 as a
 * success, so it cannot reveal who was invited.)
 */
export class RegistrationClosedError extends BasaltError {
  readonly status = 404
  constructor() {
    super('AUTH_REGISTRATION_CLOSED', 'Registration is not available here.')
  }
}

/**
 * Decides whether a NEW account may be created for this address. `tenantId`
 * is the tenant resolved for the request (`ctx().tenant?.id`), `undefined` on
 * the apex / central plane. Return `false` to refuse. Throwing fails the
 * request (fail closed). `@basaltkit/teams`' `teamsInviteGate(teams)` is the
 * ready-made "invite-only on tenant hosts" policy.
 */
export type RegisterPolicy = (input: { email: string; tenantId?: string }) => boolean | Promise<boolean>

/** The tenant id of the current request, read structurally (auth never imports tenancy). */
const currentTenantId = (): string | undefined => {
  const id = (tryCtx() as { tenant?: { id?: unknown } } | undefined)?.tenant?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** An MFA action needed an enrollment that doesn't exist. */
export class MfaNotEnrolledError extends BasaltError {
  readonly status = 400
  constructor() {
    super('AUTH_MFA_NOT_ENROLLED', 'No MFA enrollment is in progress for this account.')
  }
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

/** Authentication methods (`amr`) values Basalt issues. */
const AMR_VALUE = /^[a-z]{1,16}$/
/** Whether a value is a well-formed `amr` list (non-empty, short lowercase words). */
export const isAmr = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 8 &&
  value.every((v) => typeof v === 'string' && AMR_VALUE.test(v))

export interface SessionCookieOptions {
  /** Cookie name. Default: `basalt_session`. */
  name?: string
  /** Cookie path. Default: `/`. */
  path?: string
  /** Whether the browser may expose the cookie to JavaScript. Default: true. */
  httpOnly?: boolean
  /** SameSite policy. Default: `Lax`. */
  sameSite?: 'Strict' | 'Lax' | 'None'
  /**
   * Whether to require HTTPS. Defaults to true unless `NODE_ENV` is explicitly
   * `development` or `test` (an unset NODE_ENV counts as production).
   *
   * A `__Host-` or `__Secure-` name (matched case-insensitively) implies
   * `true` when unset (in every environment): browsers silently drop such a
   * cookie without `Secure`. An
   * explicit `false` is kept as given but warns at boot; it is refused from
   * the next major.
   */
  secure?: boolean
}

/**
 * The session cookie options violate the rules of the cookie name's prefix.
 *
 * Exported ahead of time: today such a configuration only warns at boot (the
 * cookie is emitted as configured, as before); from the next major it is
 * thrown with code `AUTH_SESSION_COOKIE_INVALID`.
 */
export class SessionCookieConfigError extends BasaltError {
  readonly status = 500
  constructor(message: string) {
    super('AUTH_SESSION_COOKIE_INVALID', message)
  }
}

/** `sessionIdleTtl` cannot be honoured as configured. */
export class SessionIdleConfigError extends BasaltError {
  readonly status = 500
  constructor(message: string) {
    super('AUTH_SESSION_IDLE_CONFIG_INVALID', message)
  }
}

/**
 * Session cookie options already warned about. Keyed on the `sessionCookie`
 * object, not on the `Auth` instance: `authPlugin` validates the options at
 * registration and the `AUTH` singleton resolves them again with the same
 * `sessionCookie` reference, so one configuration warns once.
 */
const warnedSessionCookies = new WeakSet<SessionCookieOptions>()

/**
 * Resolves the session cookie options against the cookie-prefix rules
 * browsers apply (RFC 6265bis): `__Secure-` needs `Secure`; `__Host-` needs
 * `Secure` and `Path=/` (and no `Domain`, which Basalt never sets). Prefixes
 * match case-insensitively, as in current browsers. A violating cookie is not
 * an error in the browser, it is silently dropped, so every login would
 * "succeed" without a session.
 *
 * An unset `secure` on a prefixed name takes `true`. Contradicting values
 * (`secure: false`, a `__Host-` path other than `/`) are emitted as given and
 * warn once at boot; they are refused from the next major.
 *
 * Warnings are independent, each emitted once per `sessionCookie` object:
 * - the cookie is dropped by browsers because of its prefix (refused next major);
 * - Secure is implied by the prefix where it was not before (outside
 *   production, so the emission differs from earlier versions);
 * - `SameSite=None` without `Secure`, which browsers also drop.
 */
function resolveSessionCookie(options: SessionCookieOptions | undefined): Required<SessionCookieOptions> {
  const name = options?.name ?? 'basalt_session'
  const lowerName = name.toLowerCase()
  const host = lowerName.startsWith('__host-')
  const prefixed = host || lowerName.startsWith('__secure-')
  const production = isProductionEnvironment()
  const resolved: Required<SessionCookieOptions> = {
    name,
    path: options?.path ?? '/',
    httpOnly: options?.httpOnly ?? true,
    sameSite: options?.sameSite ?? 'Lax',
    secure: options?.secure ?? (prefixed ? true : production),
  }
  if (options && !warnedSessionCookies.has(options)) {
    const warnings: string[] = []
    const problems: string[] = []
    if (prefixed && !resolved.secure) problems.push('secure: true')
    if (host && resolved.path !== '/') problems.push('path "/"')
    if (problems.length > 0) {
      warnings.push(
        `[basalt] sessionCookie: "${name}" requires ${problems.join(' / ')} - browsers drop it; this will refuse to boot in the next major.`,
      )
    }
    if (prefixed && options.secure === undefined && !production) {
      warnings.push(
        `[basalt] sessionCookie "${name}": Secure is implied by the prefix (it was not before outside production). Test clients over plain http will not send it back; use an unprefixed name outside production, or set secure explicitly (secure: true silences this).`,
      )
    }
    if (!prefixed && resolved.sameSite === 'None' && !resolved.secure) {
      warnings.push(
        `[basalt] sessionCookie "${name}": SameSite=None without Secure - browsers drop it; set secure: true or use SameSite "Lax".`,
      )
    }
    if (warnings.length > 0) {
      warnedSessionCookies.add(options)
      for (const warning of warnings) console.warn(warning)
    }
  }
  return resolved
}

/** Longest gap between two `touch` writes of one session: one minute. */
const MAX_SESSION_TOUCH_INTERVAL_MS = 60_000

/**
 * Resolves `sessionIdleTtl` to milliseconds, or undefined when unset. Fails
 * when it is not a positive duration or the session store cannot record
 * activity (`touch`). `sessions` undefined means the built-in memory store.
 */
function resolveSessionIdle(idle: DurationInput | undefined, sessions: SessionStore | undefined): number | undefined {
  if (idle === undefined) return undefined
  const idleMs = parseDuration(idle)
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new SessionIdleConfigError('sessionIdleTtl must be a positive duration.')
  }
  if (sessions !== undefined && typeof sessions.touch !== 'function') {
    throw new SessionIdleConfigError(
      'sessionIdleTtl needs a session store that implements touch(id, at) — the built-in memory, auth-sqlite and auth-prisma (trackSessionActivity: true) stores do.',
    )
  }
  return idleMs
}

/**
 * Validates the session options the way `new Auth()` does, without building
 * it — so `authPlugin` refuses a bad configuration at registration rather
 * than on the first request. Pure: no I/O.
 */
export function assertSessionOptions(options: Pick<AuthOptions, 'sessionCookie' | 'sessionIdleTtl' | 'sessions'>): void {
  resolveSessionCookie(options.sessionCookie)
  resolveSessionIdle(options.sessionIdleTtl, options.sessions)
}

export interface AuthOptions {
  users: UserSource
  secret: string
  hasher?: PasswordHasher
  sessions?: SessionStore
  refreshTokens?: RefreshTokenStore
  accessTtl?: DurationInput
  refreshTtl?: DurationInput
  /** Absolute lifetime of a server-side session. Default `30d`. */
  sessionTtl?: DurationInput
  /**
   * Idle timeout: a session unused for longer than this is refused and
   * deleted, whatever its absolute `sessionTtl`. Activity is recorded with the
   * store's `touch` at most once per `min(60s, sessionIdleTtl / 4)`, so the
   * effective idle limit can be that much longer. Requires a session store
   * that implements `touch` (memory, auth-sqlite, auth-prisma with
   * `trackSessionActivity`); construction fails otherwise. A session with no
   * `lastSeenAt` (a legacy row) starts its idle clock on its next use; one
   * that has it is measured from it, and nothing touches it while this option
   * is off, so enabling it signs out sessions created longer ago than the
   * window once. Default: no idle timeout.
   */
  sessionIdleTtl?: DurationInput
  sessionCookie?: SessionCookieOptions
  hooks?: HookBus
  /** Brute-force lockout (per email). Enabled by default; pass `false` to disable. */
  loginThrottle?: LoginThrottle | false
  /**
   * Per-IP login throttle — blunts password spraying (1 attempt across many
   * accounts) and lockout-DoS that a per-email counter alone misses. Enabled by
   * default with a higher budget than the per-email one; pass `false` to disable.
   * Only applies when the caller passes the client ip to `login`.
   */
  ipLoginThrottle?: LoginThrottle | false
  /**
   * Per-account throttle on password-reset and email-verification requests.
   * Over budget, a request is silently dropped (no new token, no hook, the live
   * link keeps working) — so the endpoints cannot be used to mail-bomb a user or
   * keep invalidating their reset link. Default: 3 per 15 minutes per account
   * and purpose; pass `false` to disable.
   */
  emailRequestThrottle?: LoginThrottle | false
  /**
   * Where the DEFAULT throttles above (login, per-ip login, email requests)
   * keep their counters. Default: in memory, per process — each replica then
   * grants its own budget. Pass a shared store (e.g. `RedisThrottleStore`) so a
   * cluster enforces one budget; each throttle uses its own namespace
   * (`login`, `login-ip`, `email-request`). Ignored for a throttle passed
   * explicitly (give that one its own `store`).
   */
  throttleStore?: ThrottleStore
  /**
   * Make the public registration endpoint enumeration-safe: a request for an
   * email that already exists returns the same response (and does equivalent
   * work) as a fresh signup, instead of a 409 that reveals the account exists.
   * Applies to {@link Auth.registerSafely} (used by the register route); the
   * lower-level {@link Auth.register} always throws on a duplicate. Default true.
   */
  enumerationSafeRegister?: boolean
  /**
   * Who may create a NEW account through the self-service paths: the public
   * register route ({@link Auth.registerSafely}, unless `authRoutes({ register })`
   * overrides it) and the create branch of {@link Auth.socialLogin}. Logins into
   * existing accounts and the trusted {@link Auth.register} are never gated.
   * Default: open.
   */
  registerPolicy?: RegisterPolicy
  /** Store for verification/reset tokens. Default: in-memory. */
  tokens?: AuthTokenStore
  /** Email-verification link lifetime. Default 24h. */
  verificationTtl?: DurationInput
  /** Password-reset link lifetime. Default 1h. */
  resetTtl?: DurationInput
  /** Store for MFA (TOTP) enrollment state. Default: in-memory. */
  mfa?: MfaStore
  /**
   * Store binding provider subjects to accounts ({@link Auth.socialLogin}).
   * Default: in-memory — use a durable one (`@basaltkit/auth-prisma`,
   * `@basaltkit/auth-sqlite`) with OAuth, or links are forgotten on restart and
   * logins fall back to the email match.
   */
  accountLinks?: AccountLinkStore
  /**
   * Enables access-token revocation. When set, access tokens carry a version
   * (`tv`) and `resetPassword`/`revokeAllTokens` bump it — invalidating every
   * token issued before the bump, even before its TTL expires. Opt-in; access
   * verification then costs one store read per request. Default: off.
   */
  tokenVersions?: TokenVersionStore
  /**
   * Encrypts TOTP secrets at rest (AES-256-GCM, HKDF-derived keys, each
   * ciphertext bound to its user). `keys` is a ring: the first key seals new
   * secrets, the others stay readable (rotation). A stored value that is not an
   * envelope sealed for that user is refused — a database write cannot swap in
   * a plaintext secret the writer knows. `legacy` reads `v1:` envelopes and/or
   * plaintext during a migration only; move rows over with
   * {@link Auth.reencryptMfaSecret}, then remove it.
   *
   * Omit (and omit {@link mfaEncryptionKey}) to store secrets in plaintext.
   */
  mfaEncryption?: { keys: SecretBoxKey[]; legacy?: SecretBoxLegacyOptions }
  /**
   * Shorthand for `mfaEncryption: { keys: [{ id: 'default', key }] }` (at least
   * 32 bytes). It does **not** read the old `v1:` envelopes or plaintext: to
   * migrate from a pre-4.0 `mfaEncryptionKey`, use `mfaEncryption` with
   * `legacy: { v1Keys: [oldKey] }`.
   */
  mfaEncryptionKey?: string | Buffer
  /** Issuer name shown in authenticator apps. Default 'Basalt'. */
  mfaIssuer?: string
}

export const publicUser = (user: AuthUser): PublicUser => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerified ?? false,
})

export class Auth {
  readonly users: UserSource
  private readonly hasher: PasswordHasher
  private readonly sessions: SessionStore
  private readonly refreshTokens: RefreshTokenStore
  private readonly secret: string
  private readonly accessTtl: DurationInput
  private readonly refreshTtl: DurationInput
  private readonly sessionTtl: DurationInput
  private readonly sessionIdleMs: number | undefined
  private readonly sessionTouchEveryMs: number
  private readonly sessionCookie: Required<SessionCookieOptions>
  private readonly hooks: HookBus | undefined
  private readonly throttle: LoginThrottle | undefined
  private readonly ipThrottle: LoginThrottle | undefined
  private readonly requestThrottle: LoginThrottle | undefined
  private readonly tokens: AuthTokenStore
  private readonly verificationTtl: DurationInput
  private readonly resetTtl: DurationInput
  private readonly mfa: MfaStore
  private readonly accountLinks: AccountLinkStore
  private readonly mfaIssuer: string
  private readonly mfaBox: SecretBox | undefined
  private readonly tokenVersions: TokenVersionStore | undefined
  private readonly enumerationSafeRegister: boolean
  private readonly registerPolicy: RegisterPolicy | undefined

  constructor(options: AuthOptions) {
    this.users = options.users
    this.secret = options.secret
    // Fail closed on a weak signing key. Always reject an empty secret; in
    // production (anything but an explicit NODE_ENV=development/test, unset
    // included) require >= 32 chars (a short HS256 key is offline-forgeable).
    if (!this.secret) throw new WeakJwtSecretError('missing')
    if (isProductionEnvironment() && this.secret.length < 32) {
      throw new WeakJwtSecretError('too short')
    }
    this.hasher = options.hasher ?? new ScryptPasswordHasher()
    this.sessions = options.sessions ?? new MemorySessionStore()
    this.refreshTokens = options.refreshTokens ?? new MemoryRefreshTokenStore()
    this.accessTtl = options.accessTtl ?? '15m'
    this.refreshTtl = options.refreshTtl ?? '30d'
    this.sessionTtl = options.sessionTtl ?? '30d'
    this.sessionIdleMs = resolveSessionIdle(options.sessionIdleTtl, this.sessions)
    this.sessionTouchEveryMs = Math.min(MAX_SESSION_TOUCH_INTERVAL_MS, (this.sessionIdleMs ?? 0) / 4)
    this.sessionCookie = resolveSessionCookie(options.sessionCookie)
    this.hooks = options.hooks
    const shared = options.throttleStore ? { store: options.throttleStore } : {}
    this.throttle =
      options.loginThrottle === false
        ? undefined
        : options.loginThrottle ?? new LoginThrottle({ ...shared, namespace: 'login' })
    this.ipThrottle =
      options.ipLoginThrottle === false
        ? undefined
        : options.ipLoginThrottle ??
          new LoginThrottle({ ...shared, namespace: 'login-ip', maxAttempts: 50, windowMs: 15 * 60_000 })
    this.requestThrottle =
      options.emailRequestThrottle === false
        ? undefined
        : options.emailRequestThrottle ??
          new LoginThrottle({ ...shared, namespace: 'email-request', maxAttempts: 3, windowMs: 15 * 60_000 })
    this.tokens = options.tokens ?? new MemoryAuthTokenStore()
    this.verificationTtl = options.verificationTtl ?? '24h'
    this.resetTtl = options.resetTtl ?? '1h'
    this.mfa = options.mfa ?? new MemoryMfaStore()
    this.accountLinks = options.accountLinks ?? new MemoryAccountLinkStore()
    this.mfaIssuer = options.mfaIssuer ?? 'Basalt'
    if (options.mfaEncryption && options.mfaEncryptionKey) {
      throw new SecretBoxKeyError('set either mfaEncryption or mfaEncryptionKey, not both.')
    }
    this.mfaBox = options.mfaEncryption
      ? new SecretBox(options.mfaEncryption)
      : options.mfaEncryptionKey
        ? new SecretBox({ keys: [{ id: 'default', key: options.mfaEncryptionKey }] })
        : undefined
    this.tokenVersions = options.tokenVersions
    this.enumerationSafeRegister = options.enumerationSafeRegister ?? true
    this.registerPolicy = options.registerPolicy
  }

  /**
   * Trusted, server-side account creation (seeding, a back-office, a flow that
   * proved the address before creating the account). Throws
   * {@link EmailTakenError} on a duplicate and is never gated by a
   * {@link RegisterPolicy}. `emailVerified: true` creates the account already
   * verified; `auth:registered` then carries the final state, so a mail hook
   * can decide "unverified → send the verification link" on its own. Never
   * forward this option from a request body.
   *
   * `emailVerified: true` needs a `UserSource` with `update()` — the same
   * requirement as email verification. Without it this throws
   * {@link UserUpdateUnsupportedError} **before** anything is written: whether
   * `create()` persists the flag can only be learnt by writing the row, and a
   * row that cannot be fixed afterwards would be a half-done registration
   * (an unverified account that a retry reports as `EmailTakenError`).
   */
  async register(rawEmail: string, password: string, opts: { emailVerified?: boolean } = {}): Promise<PublicUser> {
    if (opts.emailVerified === true && typeof this.users.update !== 'function') throw new UserUpdateUnsupportedError()
    const email = canonicalEmail(rawEmail)
    if (await this.users.findByEmail(email)) throw new EmailTakenError()
    const user = await this.createUser(email, await this.hasher.hash(password), opts.emailVerified === true)
    await this.hooks?.emit('auth:registered', { user: publicUser(user) })
    return publicUser(user)
  }

  /**
   * Creates the row with the requested verification state. A custom
   * `UserSource` written before `create()` took `emailVerified` may drop the
   * flag: it is then set through `update()`.
   *
   * When the source can do neither (no `update()` and a `create()` that drops
   * the flag), `onUnsupported` decides: `'throw'` fails loudly with
   * {@link UserUpdateUnsupportedError} (trusted `register`, whose caller asked
   * for a verified account and must hear it did not get one — `register`
   * refuses a source without `update()` before calling this, so here it only
   * fires for an `update()` that does not persist the flag); `'keep'` returns
   * the row as it really is, unverified (social login — the row was just
   * created by this call with an unusable password, so it is provably ours and
   * must be linked and used, never left behind as an orphan that locks the
   * provider account out on every later login).
   */
  private async createUser(
    email: string,
    passwordHash: string,
    emailVerified: boolean,
    onUnsupported: 'throw' | 'keep' = 'throw',
  ): Promise<AuthUser> {
    // Decided before anything is written, so the outcome never depends on
    // how far a half-done create got.
    const canPatch = typeof this.users.update === 'function'
    let user = await this.users.create(emailVerified ? { email, passwordHash, emailVerified: true } : { email, passwordHash })
    if (emailVerified && user.emailVerified !== true) {
      if (canPatch) user = (await this.users.update!(user.id, { emailVerified: true })) ?? user
      if (user.emailVerified !== true && onUnsupported === 'throw') throw new UserUpdateUnsupportedError()
    }
    return user
  }

  /**
   * Logs in an externally-authenticated user (e.g. from an OAuth provider) —
   * find-or-create. A new account is created **passwordless** (a random,
   * unusable password hash), so password login won't work for it until a
   * password is set. A provider-verified email flips `emailVerified`. Returns
   * the tokens and whether the account was just created.
   *
   * With an `identity` (the provider name and its stable `subject`, which
   * {@link OAuth} always passes) the account is matched by that link first
   * (see {@link AccountLinkStore}): a linked provider account reaches its local
   * account whatever email it asserts today. Without a link, the account is
   * matched by email and the link is recorded — for an existing account only
   * under the rules below. Once an account is linked to a provider, a
   * **different** subject of that provider asserting the same email is refused
   * ({@link AccountLinkConflictError}) unless `subjectConflict: 'link'`.
   *
   * Linking to an EXISTING account is refused ({@link SocialLinkRefusedError})
   * unless `emailVerified` is `true` — an unverified provider email proves
   * nothing about who owns the address. When the existing account had never
   * verified its email, whoever registered it first is not trusted either: its
   * password, sessions, refresh tokens, MFA and account links are revoked
   * before it is adopted (`auth:social_account_adopted`). An account with MFA
   * enabled requires `mfaCode` ({@link MfaRequiredError}) unless `mfa: 'skip'`
   * is passed explicitly (only for an IdP that enforces its own second factor).
   */
  async socialLogin(
    rawEmail: string,
    options: {
      emailVerified?: boolean
      mfaCode?: string
      mfa?: 'required' | 'skip'
      /** The provider account behind this login; matched before the email. */
      identity?: { provider: string; subject: string }
      /**
       * An account already linked to another subject of the same provider:
       * `'refuse'` (default) or `'link'` this subject as well. Only for an IdP
       * that legitimately re-issues subjects (a directory migration).
       */
      subjectConflict?: 'refuse' | 'link'
      /**
       * The tenant this login happens on, for the {@link RegisterPolicy}.
       * Default: the current request's `ctx().tenant?.id`.
       */
      tenantId?: string
    } = {},
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean; amr: string[] }> {
    const email = canonicalEmail(rawEmail)
    const identity = options.identity
    if (identity !== undefined) {
      if (!isLinkPart(identity.provider) || !isLinkPart(identity.subject)) throw new SocialLinkRefusedError()
    }
    const amr = ['fed']

    // 1. A known provider account: the link decides, not the email.
    if (identity) {
      const link = await this.accountLinks.find(identity.provider, identity.subject)
      if (link) {
        const linked = await this.users.findById(link.userId)
        if (linked) {
          await this.requireMfaForSocial(linked, options, amr)
          return this.finishSocialLogin(linked, false, amr)
        }
        // The account is gone: the stale link must not block a fresh start.
        await this.accountLinks.remove(identity.provider, identity.subject)
      }
    }

    // 2. First login of this provider account: match by email.
    let user = await this.users.findByEmail(email)
    let created = false
    if (!user) {
      // A social login is already an authenticated flow, so a refusal is said
      // out loud (the provider vouched for the caller's address).
      const tenantId = options.tenantId ?? currentTenantId()
      if (this.registerPolicy && !(await this.registerPolicy(tenantId === undefined ? { email } : { email, tenantId }))) {
        await this.hooks?.emit('auth:register_refused', { email, ...(tenantId !== undefined ? { tenantId } : {}), source: 'social' })
        throw new RegistrationClosedError()
      }
      // Created with its final verification state, so `auth:registered`
      // reports what the account really is. A source that cannot record the
      // verification (no `update()`, a `create()` that drops the flag) keeps
      // the account unverified rather than fail after the row exists: a
      // half-done first login would leave an unlinked, unverified row that
      // every later login refuses to adopt (`AUTH_SOCIAL_LINK_REFUSED`).
      user = await this.createUser(
        email,
        await this.hasher.hash(randomBytes(32).toString('hex')),
        options.emailVerified === true,
        'keep',
      )
      created = true
      await this.hooks?.emit('auth:registered', { user: publicUser(user) })
    } else {
      if (options.emailVerified !== true) throw new SocialLinkRefusedError()
      if (identity && options.subjectConflict !== 'link' && user.emailVerified) {
        const others = (await this.accountLinks.forUser(user.id)).filter(
          (l) => l.provider === identity.provider && l.subject !== identity.subject,
        )
        if (others.length > 0) throw new AccountLinkConflictError()
      }
      if (!user.emailVerified) {
        user = await this.adoptUnverifiedAccount(user)
      } else {
        await this.requireMfaForSocial(user, options, amr)
      }
    }
    if (identity) await this.linkIdentity(identity, user, email)
    return this.finishSocialLogin(user, created, amr)
  }

  /** Records the link; a concurrent first login that bound the subject elsewhere wins. */
  private async linkIdentity(identity: { provider: string; subject: string }, user: AuthUser, email: string): Promise<void> {
    const inserted = await this.accountLinks.create({ ...identity, userId: user.id, email, createdAt: Date.now() })
    if (inserted) {
      await this.hooks?.emit('auth:account_linked', { user: publicUser(user), provider: identity.provider })
      return
    }
    const existing = await this.accountLinks.find(identity.provider, identity.subject)
    if (existing?.userId !== user.id) throw new AccountLinkConflictError()
  }

  /** MFA gate of a social login into an existing account (see {@link socialLogin}). */
  private async requireMfaForSocial(user: AuthUser, options: { mfaCode?: string; mfa?: 'required' | 'skip' }, amr: string[]): Promise<void> {
    if (options.mfa === 'skip' || !(await this.isMfaEnabled(user.id))) return
    if (!options.mfaCode) throw new MfaRequiredError()
    const key = user.email
    await this.throttle?.reserve(key)
    if (!(await this.verifyMfaCode(user.id, options.mfaCode))) {
      await this.hooks?.emit('auth:mfa_failed', { userId: user.id })
      throw new MfaInvalidCodeError()
    }
    await this.throttle?.reset(key)
    amr.push('mfa')
  }

  private async finishSocialLogin(
    user: AuthUser,
    created: boolean,
    amr: string[],
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean; amr: string[] }> {
    const tokens = await this.issueTokens(user.id, undefined, amr)
    await this.hooks?.emit('auth:login', { user: publicUser(user) })
    return { user: publicUser(user), tokens, created, amr }
  }

  /**
   * A provider-verified login is taking over an account whose email was never
   * verified: whoever registered it could be anyone (pre-account hijacking), so
   * every credential they may hold is revoked before the verified owner gets in.
   */
  private async adoptUnverifiedAccount(user: AuthUser): Promise<AuthUser> {
    if (!this.users.update) throw new SocialLinkRefusedError()
    const adopted =
      (await this.users.update(user.id, {
        passwordHash: await this.hasher.hash(randomBytes(32).toString('hex')),
        emailVerified: true,
      })) ?? user
    await this.refreshTokens.revokeAllForUser?.(user.id)
    await this.sessions.deleteAllForUser?.(user.id)
    await this.tokenVersions?.increment(user.id)
    await this.mfa.delete(user.id)
    // A provider account linked by whoever registered it is a login credential too.
    await this.accountLinks.deleteAllForUser(user.id)
    await this.hooks?.emit('auth:social_account_adopted', { user: publicUser(adopted) })
    return adopted
  }

  /**
   * Enumeration-safe registration for the public endpoint: creates the account
   * for a new email, or — when the email is already taken — does equivalent work
   * (so timing doesn't leak) and emits `auth:register_existing_email` so the app
   * can send an out-of-band "you already have an account" email. Returns nothing
   * either way, so the response can't reveal whether the account existed.
   *
   * With `enumerationSafeRegister: false` it throws {@link EmailTakenError} on a
   * duplicate instead (the classic, enumerable behavior).
   *
   * A {@link RegisterPolicy} (`opts.policy`, else `registerPolicy` of the
   * options; `null` = open) is asked first. A refusal creates nothing, does the
   * same hashing work and emits `auth:register_refused` — the caller sees the
   * same outcome as a success, so the response never tells who was invited.
   * Never creates a verified account.
   */
  async registerSafely(
    rawEmail: string,
    password: string,
    opts: { policy?: RegisterPolicy | null; tenantId?: string } = {},
  ): Promise<void> {
    const email = canonicalEmail(rawEmail)
    const policy = opts.policy === undefined ? this.registerPolicy : (opts.policy ?? undefined)
    if (policy) {
      const tenantId = opts.tenantId ?? currentTenantId()
      if (!(await policy(tenantId === undefined ? { email } : { email, tenantId }))) {
        await this.hasher.hash(password)
        await this.hooks?.emit('auth:register_refused', { email, ...(tenantId !== undefined ? { tenantId } : {}), source: 'register' })
        return
      }
    }
    const existing = await this.users.findByEmail(email)
    if (existing) {
      if (!this.enumerationSafeRegister) throw new EmailTakenError()
      // Equalize timing with the create path (which hashes), then signal the
      // collision out-of-band — never in the HTTP response.
      await this.hasher.hash(password)
      await this.hooks?.emit('auth:register_existing_email', { email })
      return
    }
    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
    })
    await this.hooks?.emit('auth:registered', { user: publicUser(user) })
  }

  /** Verifies credentials without side effects. Null on failure. */
  async attempt(email: string, password: string): Promise<AuthUser | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user) {
      // Equalize timing: a missing account must cost the same as a wrong
      // password, or the response time reveals which emails are registered
      // (account enumeration). Verify against a throwaway hash and discard.
      await this.hasher.verify(password, await this.dummyHash())
      return null
    }
    return (await this.hasher.verify(password, user.passwordHash)) ? user : null
  }

  private dummyHashPromise?: Promise<string>
  /** A valid hash of a throwaway secret, produced once by the configured hasher. */
  private dummyHash(): Promise<string> {
    return (this.dummyHashPromise ??= this.hasher.hash('basalt-timing-equalizer'))
  }

  /**
   * Credentials → token pair. Emits auth:login / auth:login_failed. Locks the
   * account after too many failures (see {@link LoginThrottle}); a success
   * clears the counter.
   *
   * When the account has MFA enabled, `mfaCode` (a TOTP or recovery code) is
   * required: a correct password with a missing code throws
   * {@link MfaRequiredError}, and a wrong code throws {@link MfaInvalidCodeError}.
   * Because `MfaRequiredError` reveals that the password was right, it counts
   * against the per-account and per-IP login budgets exactly like a failure
   * (a later successful login with the code clears the account counter).
   *
   * `amr` lists the authentication methods used — `['pwd']`, or
   * `['pwd', 'mfa']` when a second factor was verified. It is also embedded in
   * the access token (`amr` claim) and carried by every refresh of this login;
   * pass it to {@link createSession} so a cookie session carries it too.
   */
  async login(
    email: string,
    password: string,
    mfaCode?: string,
    context: { ip?: string } = {},
  ): Promise<{ user: PublicUser; tokens: TokenPair; amr: string[] }> {
    const key = canonicalEmail(email)
    const ipKey = context.ip ? `ip:${context.ip}` : undefined
    // Reserve the attempt BEFORE the (async) verification: the counter moves
    // synchronously, so a parallel burst cannot run more password or MFA
    // guesses than the budget allows. Success gives the reservation back.
    try {
      await this.throttle?.reserve(key)
    } catch (error) {
      await this.hooks?.emit('auth:locked_out', { email: key })
      throw error
    }
    if (ipKey && this.ipThrottle) {
      try {
        await this.ipThrottle.reserve(ipKey)
      } catch (error) {
        await this.throttle?.release(key)
        await this.hooks?.emit('auth:locked_out', { email: key, ip: context.ip as string })
        throw error
      }
    }

    const user = await this.attempt(key, password)
    if (!user) {
      await this.hooks?.emit('auth:login_failed', { email: key })
      throw new InvalidCredentialsError()
    }

    const amr = ['pwd']
    if (await this.isMfaEnabled(user.id)) {
      if (!mfaCode) {
        // The password was right, and this answer says so — a password oracle
        // on MFA accounts (the industry-standard two-step flow). Keep BOTH
        // reservations (per-account and per-IP) so the oracle is throttled like
        // any other guess: a success with the code resets the account counter
        // and frees its own IP slot; this step's IP slot expires with the window.
        throw new MfaRequiredError()
      }
      if (!(await this.verifyMfaCode(user.id, mfaCode))) {
        await this.hooks?.emit('auth:mfa_failed', { userId: user.id })
        throw new MfaInvalidCodeError()
      }
      amr.push('mfa')
    }

    await this.throttle?.reset(key)
    if (ipKey) await this.ipThrottle?.release(ipKey)
    const tokens = await this.issueTokens(user.id, undefined, amr)
    await this.hooks?.emit('auth:login', { user: publicUser(user) })
    return { user: publicUser(user), tokens, amr }
  }

  /**
   * Refresh rotation with reuse detection: every refresh consumes the token
   * and issues a new one in the same family. If a consumed token comes back
   * (theft indicator), the whole family is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const hashed = this.hashToken(refreshToken)
    const record = await this.refreshTokens.find(hashed)
    if (!record) throw new RefreshInvalidError()
    if (record.usedAt !== undefined) return this.reuseDetected(record.userId, record.familyId)
    if (Date.now() >= record.expiresAt) throw new RefreshInvalidError()
    // A deleted account must not keep minting tokens from a leftover refresh token.
    if (!(await this.users.findById(record.userId))) {
      await this.refreshTokens.revokeFamily(record.familyId)
      throw new RefreshInvalidError()
    }

    // Compare-and-swap: `false` means another caller consumed this exact token
    // between our read and this write — the very race reuse detection exists for.
    if ((await this.refreshTokens.markUsed(hashed)) === false) {
      return this.reuseDetected(record.userId, record.familyId)
    }
    const pair = await this.issueTokens(record.userId, record.familyId, amrOfFamily(record.familyId))
    // The consumed token is the witness that the family is still alive:
    // revokeFamily/revokeAllForUser delete every row of it. If a concurrent
    // revocation (a reuse loser, a logout, a logout-everywhere) ran between our
    // CAS and the insert above, the row is gone — revoke again so the token we
    // just stored does not outlive its family, and refuse.
    if (!(await this.refreshTokens.find(hashed))) {
      await this.refreshTokens.revokeFamily(record.familyId)
      throw new RefreshReusedError()
    }
    return pair
  }

  private async reuseDetected(userId: string, familyId: string): Promise<never> {
    await this.refreshTokens.revokeFamily(familyId)
    await this.hooks?.emit('auth:refresh_reused', { userId, familyId })
    throw new RefreshReusedError()
  }

  /** Revokes a refresh family — logout for token-based clients. */
  async revoke(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.find(this.hashToken(refreshToken))
    if (record) await this.refreshTokens.revokeFamily(record.familyId)
  }

  /** Structural JWT verification only (signature + expiry). */
  verifyAccess(accessToken: string): JwtClaims {
    return verifyJwt(accessToken, this.secret)
  }

  /**
   * Verifies the access token AND, when token-version revocation is enabled,
   * rejects a token minted before the user's version was last bumped (i.e.
   * revoked by a password reset / `revokeAllTokens`). Prefer this over
   * {@link verifyAccess} on the request path.
   */
  async verifyAccessToken(accessToken: string): Promise<JwtClaims> {
    const claims = this.verifyAccess(accessToken)
    if (this.tokenVersions) {
      const current = await this.tokenVersions.get(claims.sub)
      if ((claims.tv ?? 0) < current) throw new AuthTokenInvalidError()
    }
    return claims
  }

  /**
   * Revokes every access token issued so far for the user (logout-everywhere),
   * revoking every refresh token and server-side session (when the stores
   * implement `revokeAllForUser` / `deleteAllForUser`, as the bundled ones do)
   * and bumping the token version so outstanding access tokens die too (needs a
   * {@link TokenVersionStore}; without one, access tokens live until their TTL).
   */
  async revokeAllTokens(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser?.(userId)
    await this.sessions.deleteAllForUser?.(userId)
    await this.tokenVersions?.increment(userId)
  }

  /**
   * Creates a server-side session. With `amr` (from {@link login}), the
   * returned id — the value to put in the cookie — also carries those
   * authentication methods, HMAC-signed with the auth secret so a client cannot
   * add `mfa` to a password-only session. Stores are unaffected: they only
   * ever see the random part.
   */
  async createSession(userId: string, options: { amr?: readonly string[] } = {}): Promise<SessionRecord> {
    const record = await this.sessions.create(userId, parseDuration(this.sessionTtl))
    const amr = options.amr ? [...options.amr] : undefined
    if (!amr || !isAmr(amr)) return record
    const tag = amr.join('+')
    return { ...record, id: `${record.id}.${tag}.${this.sessionTagSignature(record.id, tag)}` }
  }

  private sessionTagSignature(rawId: string, tag: string): string {
    return createHmac('sha256', this.secret).update(`basalt-session-amr\u0000${rawId}.${tag}`).digest('base64url')
  }

  /** Splits a session id minted by {@link createSession} into the store id and its signed `amr`. */
  private parseSessionId(sessionId: string): { rawId: string; amr?: string[] } {
    const parts = sessionId.split('.')
    if (parts.length !== 3) return { rawId: sessionId }
    const [rawId, tag, signature] = parts as [string, string, string]
    const expected = Buffer.from(this.sessionTagSignature(rawId, tag))
    const received = Buffer.from(signature)
    const amr = tag.split('+')
    if (expected.length !== received.length || !timingSafeEqual(expected, received) || !isAmr(amr)) {
      // Not a signed composite: treat the whole value as an opaque store id
      // (a tampered composite then simply matches no session).
      return { rawId: sessionId }
    }
    return { rawId, amr }
  }

  sessionCookieHeader(sessionId: string): string {
    const ttlMs = parseDuration(this.sessionTtl)
    const cookie = this.sessionCookie
    const expires = new Date(Date.now() + ttlMs).toUTCString()
    return `${cookie.name}=${encodeURIComponent(sessionId)}; Path=${cookie.path};${cookie.httpOnly ? ' HttpOnly;' : ''} SameSite=${cookie.sameSite}; Max-Age=${Math.max(1, Math.floor(ttlMs / 1000))}; Expires=${expires}${cookie.secure ? '; Secure' : ''}`
  }

  sessionIdFromCookie(cookieHeader?: string): string | null {
    if (!cookieHeader) return null
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === this.sessionCookie.name && rest.length > 0) {
        // An unreadable cookie (malformed percent-encoding, e.g. tossed by a
        // sibling subdomain) is no credential: the request is anonymous. It
        // must never throw — the enricher runs on every route, public ones
        // included, so a URIError here would 500 the whole site.
        try {
          return decodeURIComponent(rest.join('='))
        } catch {
          return null
        }
      }
    }
    return null
  }

  expiredSessionCookieHeader(): string {
    const cookie = this.sessionCookie
    return `${cookie.name}=; Path=${cookie.path};${cookie.httpOnly ? ' HttpOnly;' : ''} SameSite=${cookie.sameSite}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${cookie.secure ? '; Secure' : ''}`
  }

  async sessionUser(sessionId: string): Promise<AuthUser | null> {
    return (await this.sessionAuth(sessionId))?.user ?? null
  }

  /**
   * The user of a session plus the authentication methods it was created with
   * (`amr` is absent for sessions created without them, e.g. before this option).
   */
  async sessionAuth(sessionId: string): Promise<{ user: AuthUser; amr?: string[] } | null> {
    const { rawId, amr } = this.parseSessionId(sessionId)
    const session = await this.sessions.find(rawId)
    if (session && !(await this.sessionStillActive(rawId, session))) return null
    const user = session ? await this.users.findById(session.userId) : null
    if (!user) return null
    return amr ? { user, amr } : { user }
  }

  /**
   * Applies the idle timeout: refuses (and deletes) a session idle for longer
   * than `sessionIdleTtl`, otherwise records the activity, throttled. A no-op
   * without `sessionIdleTtl`.
   */
  private async sessionStillActive(rawId: string, session: SessionRecord): Promise<boolean> {
    const idleMs = this.sessionIdleMs
    if (idleMs === undefined) return true
    const now = Date.now()
    const lastSeenAt = session.lastSeenAt
    if (lastSeenAt !== undefined && now - lastSeenAt > idleMs) {
      await this.sessions.delete(rawId)
      return false
    }
    if (lastSeenAt === undefined || now - lastSeenAt >= this.sessionTouchEveryMs) {
      await this.sessions.touch?.(rawId, now)
    }
    return true
  }

  async logout(sessionId: string): Promise<void> {
    const { rawId } = this.parseSessionId(sessionId)
    const session = await this.sessions.find(rawId)
    await this.sessions.delete(rawId)
    if (session) {
      const user = await this.users.findById(session.userId)
      if (user) await this.hooks?.emit('auth:logout', { user: publicUser(user) })
    }
  }

  // --- email verification --------------------------------------------------

  /**
   * Starts email verification: mints a single-use token and emits
   * `auth:verify_requested` for the app to email. Returns the token (so a
   * caller can build the link) or null if no account matches — never reveals
   * whether the email exists.
   */
  async requestEmailVerification(email: string): Promise<{ user: PublicUser; token: string } | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user || !(await this.allowEmailRequest('verify_email', user.id))) return null
    const token = await this.issueOneTimeToken(user.id, 'verify_email', this.verificationTtl)
    await this.hooks?.emit('auth:verify_requested', { user: publicUser(user), token })
    return { user: publicUser(user), token }
  }

  /** Consumes a verification token and marks the user's email verified. */
  async verifyEmail(token: string): Promise<PublicUser> {
    const record = await this.consumeToken(token, 'verify_email')
    const user = await this.updateUser(record.userId, { emailVerified: true })
    await this.hooks?.emit('auth:email_verified', { user: publicUser(user) })
    return publicUser(user)
  }

  /** Per-account budget for reset/verification mails; false = drop silently. */
  private async allowEmailRequest(purpose: AuthTokenPurpose, userId: string): Promise<boolean> {
    if (!this.requestThrottle) return true
    try {
      await this.requestThrottle.reserve(`${purpose}:${userId}`)
      return true
    } catch {
      return false
    }
  }

  // --- password reset ------------------------------------------------------

  /**
   * Starts a password reset: mints a single-use token and emits
   * `auth:password_reset_requested`. Returns null when no account matches (or
   * the per-account request budget is spent — the live link then stays valid),
   * so the caller always responds 200 (no account enumeration).
   */
  async requestPasswordReset(email: string): Promise<{ user: PublicUser; token: string } | null> {
    const user = await this.users.findByEmail(canonicalEmail(email))
    if (!user || !(await this.allowEmailRequest('reset_password', user.id))) return null
    const token = await this.issueOneTimeToken(user.id, 'reset_password', this.resetTtl)
    await this.hooks?.emit('auth:password_reset_requested', { user: publicUser(user), token })
    return { user: publicUser(user), token }
  }

  /**
   * Consumes a reset token, sets the new password, and revokes every existing
   * session/refresh token for the user (a reset logs everyone else out).
   */
  async resetPassword(token: string, newPassword: string): Promise<PublicUser> {
    const record = await this.consumeToken(token, 'reset_password')
    const user = await this.updateUser(record.userId, {
      passwordHash: await this.hasher.hash(newPassword),
    })
    // A reset must lock out anyone already in — both token-based clients and
    // active server-side sessions (cookie logins survived this before).
    await this.refreshTokens.revokeAllForUser?.(user.id)
    await this.sessions.deleteAllForUser?.(user.id)
    // Bump the token version so outstanding access tokens are rejected before
    // their TTL expires (no-op unless a TokenVersionStore is configured).
    await this.tokenVersions?.increment(user.id)
    await this.hooks?.emit('auth:password_reset', { user: publicUser(user) })
    return publicUser(user)
  }

  // --- MFA (TOTP) ----------------------------------------------------------

  async isMfaEnabled(userId: string): Promise<boolean> {
    return (await this.mfa.get(userId))?.enabled ?? false
  }

  async mfaStatus(userId: string): Promise<{ enabled: boolean; pending: boolean }> {
    const record = await this.mfa.get(userId)
    return { enabled: record?.enabled ?? false, pending: record !== null && !record.enabled }
  }

  /** Encrypt a TOTP secret for storage, bound to its user (no-op when no key is configured). */
  private encryptMfaSecret(userId: string, secret: string): string {
    return this.mfaBox ? this.mfaBox.seal(secret, { purpose: 'totp', subject: userId }) : secret
  }

  /**
   * Decrypt a stored TOTP secret. With encryption configured, only an envelope
   * sealed for this user opens; plaintext and `v1:` values need the explicit
   * legacy opt-in (otherwise `AUTH_SECRET_UNREADABLE`, failing closed).
   */
  private decryptMfaSecret(userId: string, stored: string): string {
    return this.mfaBox ? this.mfaBox.open(stored, { purpose: 'totp', subject: userId }) : stored
  }

  /**
   * Re-encrypts one user's stored TOTP secret under the active key of
   * `mfaEncryption` — for key rotation, and to migrate `v1:` envelopes or
   * plaintext secrets (reading those needs the matching `legacy` opt-in).
   * Returns `'resealed'` when the row was rewritten, `'current'` when it was
   * already sealed with the active key, `'none'` when the user has no MFA
   * record. Run it over every user id with an MFA row, then drop `legacy`.
   */
  async reencryptMfaSecret(userId: string): Promise<'resealed' | 'current' | 'none'> {
    if (!this.mfaBox) throw new SecretBoxKeyError('reencryptMfaSecret needs mfaEncryption (or mfaEncryptionKey).')
    const record = await this.mfa.get(userId)
    if (!record) return 'none'
    const resealed = this.mfaBox.reseal(record.secret, { purpose: 'totp', subject: userId })
    if (resealed === null) return 'current'
    await this.mfa.set(userId, { ...record, secret: resealed })
    return 'resealed'
  }

  /**
   * Begins MFA enrollment: generates a fresh secret (not yet active) and
   * returns it plus an `otpauth://` URI to render as a QR code. Call
   * {@link activateMfa} with a code from the app to switch it on.
   */
  async enrollMfa(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.users.findById(userId)
    if (!user) throw new AuthRequiredError()
    // Overwriting an active record would switch MFA off without a code —
    // exactly what disableMfa() refuses to do.
    if ((await this.mfa.get(userId))?.enabled) throw new MfaAlreadyEnabledError()
    const secret = generateTotpSecret()
    await this.mfa.set(userId, { secret: this.encryptMfaSecret(userId, secret), enabled: false, recoveryCodes: [] })
    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer: this.mfaIssuer }),
    }
  }

  /**
   * Confirms enrollment by checking a code against the pending secret, enables
   * MFA, and returns freshly generated single-use recovery codes (shown once).
   */
  async activateMfa(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const record = await this.mfa.get(userId)
    if (!record || record.enabled) throw new MfaNotEnrolledError()
    const step = matchTotpStep(this.decryptMfaSecret(userId, record.secret), code)
    if (step === null) throw new MfaInvalidCodeError()

    const recoveryCodes = Array.from({ length: 10 }, () => this.generateRecoveryCode())
    await this.mfa.set(userId, {
      secret: record.secret,
      enabled: true,
      recoveryCodes: recoveryCodes.map((c) => this.hashRecoveryCode(c)),
    })
    const user = await this.users.findById(userId)
    if (user) await this.hooks?.emit('auth:mfa_enabled', { user: publicUser(user) })
    return { recoveryCodes }
  }

  /** Turns MFA off. Requires a valid current code (or recovery code). */
  async disableMfa(userId: string, code: string): Promise<void> {
    if (!(await this.isMfaEnabled(userId))) throw new MfaNotEnrolledError()
    if (!(await this.verifyMfaCode(userId, code))) throw new MfaInvalidCodeError()
    await this.mfa.delete(userId)
    const user = await this.users.findById(userId)
    if (user) await this.hooks?.emit('auth:mfa_disabled', { user: publicUser(user) })
  }

  /**
   * Verifies a TOTP code or, failing that, a single-use recovery code (which
   * is consumed on success). Returns false unless MFA is enabled.
   */
  async verifyMfaCode(userId: string, code: string): Promise<boolean> {
    const record = await this.mfa.get(userId)
    if (!record || !record.enabled) return false
    const step = matchTotpStep(this.decryptMfaSecret(userId, record.secret), code)
    if (step !== null) {
      // Anti-replay: a code from a step already used cannot be reused within
      // its ~90s window (an intercepted code is single-use).
      if (record.lastUsedStep !== undefined && step <= record.lastUsedStep) return false
      // Atomic consume when the store supports it: two parallel requests with
      // the same code must not both pass the read-then-write above.
      if (this.mfa.consumeTotpStep) return this.mfa.consumeTotpStep(userId, step)
      record.lastUsedStep = step
      await this.mfa.set(userId, record)
      return true
    }

    const hash = this.hashRecoveryCode(code)
    const index = record.recoveryCodes.indexOf(hash)
    if (index === -1) return false
    if (this.mfa.consumeRecoveryCode) return this.mfa.consumeRecoveryCode(userId, hash)
    record.recoveryCodes.splice(index, 1) // consume it
    await this.mfa.set(userId, record)
    return true
  }

  private generateRecoveryCode(): string {
    // 80 bits of entropy (was 40): a leaked recovery-code hash can't be brute
    // forced offline even with a fast/unsalted digest. 20 hex chars, grouped.
    const raw = randomBytes(10).toString('hex')
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256').update(code.replace(/-/g, '').toLowerCase()).digest('hex')
  }

  // --- token helpers -------------------------------------------------------

  /** SHA-256 of a bearer secret (one-time token, refresh token) — only this is
   * persisted, so a leak of the token/session table can't be replayed. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private async issueOneTimeToken(userId: string, purpose: AuthTokenPurpose, ttl: DurationInput): Promise<string> {
    await this.tokens.deleteForUser(userId, purpose) // one live token per purpose
    const token = randomBytes(32).toString('base64url')
    // Store only the hash: a leak of the token table can't be replayed to reset
    // or verify accounts (the raw token lives only in the user's inbox/link).
    await this.tokens.create({
      token: this.hashToken(token),
      userId,
      purpose,
      expiresAt: Date.now() + parseDuration(ttl),
    })
    return token
  }

  private async consumeToken(token: string, purpose: AuthTokenPurpose) {
    const hashed = this.hashToken(token)
    const record = await this.tokens.find(hashed)
    if (!record || record.purpose !== purpose || record.usedAt !== undefined || Date.now() >= record.expiresAt) {
      throw new AuthTokenInvalidError()
    }
    // Compare-and-swap: a concurrent consumer of this single-use token wins, and
    // this call is rejected as if the token had already been spent.
    if ((await this.tokens.markUsed(hashed)) === false) throw new AuthTokenInvalidError()
    return record
  }

  private async updateUser(id: string, patch: UserPatch): Promise<AuthUser> {
    if (!this.users.update) throw new UserUpdateUnsupportedError()
    const user = await this.users.update(id, patch)
    if (!user) throw new AuthTokenInvalidError() // user vanished between issue and consume
    return user
  }

  private async issueTokens(userId: string, family?: string, amr?: string[]): Promise<TokenPair> {
    // A new family records the login's authentication methods in its id, so
    // every rotation carries them forward without a store schema change.
    const familyId = family ?? (amr && isAmr(amr) ? `${randomUUID()}.${amr.join('+')}` : randomUUID())
    const refreshToken = randomBytes(32).toString('base64url')
    await this.refreshTokens.create({
      // Persist only the hash; the raw token is returned to the client below.
      token: this.hashToken(refreshToken),
      familyId,
      userId,
      expiresAt: Date.now() + parseDuration(this.refreshTtl),
    })
    const tv = this.tokenVersions ? await this.tokenVersions.get(userId) : undefined
    return {
      accessToken: signJwt(
        { sub: userId, ...(tv !== undefined ? { tv } : {}), ...(amr && isAmr(amr) ? { amr } : {}) },
        { secret: this.secret, expiresIn: this.accessTtl },
      ),
      refreshToken,
    }
  }
}

/** The `amr` recorded in a refresh family id by {@link Auth} (undefined for older families). */
function amrOfFamily(familyId: string): string[] | undefined {
  const dot = familyId.lastIndexOf('.')
  if (dot === -1) return undefined
  const amr = familyId.slice(dot + 1).split('+')
  return isAmr(amr) ? amr : undefined
}
