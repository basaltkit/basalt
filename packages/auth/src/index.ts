export { ScryptPasswordHasher, type PasswordHasher } from './hashing.js'
export {
  signJwt,
  verifyJwt,
  TokenInvalidError,
  TokenExpiredError,
  type JwtClaims,
} from './jwt.js'
export {
  MemoryUserSource,
  MemorySessionStore,
  MemoryRefreshTokenStore,
  MemoryAuthTokenStore,
  MemoryApiKeyStore,
  MemoryMfaStore,
  MemoryTokenVersionStore,
  type TokenVersionStore,
  type AuthUser,
  type PublicUser,
  type UserSource,
  type UserPatch,
  type SessionStore,
  type SessionRecord,
  type RefreshTokenStore,
  type RefreshRecord,
  type AuthTokenStore,
  type AuthTokenRecord,
  type AuthTokenPurpose,
  type ApiKeyStore,
  type ApiKeyRecord,
  type ApiKeyInfo,
  type ApiKeyFilter,
  type MfaStore,
  type MfaRecord,
} from './stores.js'

declare module '@basaltkit/http' {
  interface RouteMeta {
    /** `true` requires a session; `false` opts a route out. */
    auth?: boolean
    /**
     * `true`: the route requires a credential obtained with a second factor
     * (step-up). `false`: exempt from `authPlugin({ requireMfa })`.
     */
    mfa?: boolean
    /**
     * The route is about the caller's own account (sign-in, profile, MFA,
     * accepting an invitation), not a tenant's data: tenant-membership guards
     * (`@basaltkit/teams`' `tenantMembershipPlugin`) let non-members through.
     */
    account?: boolean
  }
}

export {
  Auth,
  publicUser,
  InvalidCredentialsError,
  EmailTakenError,
  WeakJwtSecretError,
  RefreshInvalidError,
  RefreshReusedError,
  AuthRequiredError,
  AuthTokenInvalidError,
  UserUpdateUnsupportedError,
  MfaRequiredError,
  MfaStepUpRequiredError,
  MfaEnrollmentRequiredError,
  MfaInvalidCodeError,
  MfaNotEnrolledError,
  MfaAlreadyEnabledError,
  SocialLinkRefusedError,
  canonicalEmail,
  type AuthOptions,
  type SessionCookieOptions,
  type TokenPair,
} from './auth.js'
export {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totp,
  verifyTotp,
  matchTotpStep,
  otpauthUri,
  type TotpOptions,
  type VerifyTotpOptions,
  type OtpauthUriInput,
} from './totp.js'
export { authPlugin, AUTH, CsrfRejectedError, type AuthPluginOptions, type CsrfOptions } from './plugin.js'
export {
  ApiKeys,
  ApiKeyExpirationError,
  ScopeRequiredError,
  scopesSatisfy,
  type ApiKeysOptions,
  type IssueApiKeyInput,
  type ApiKeyContext,
} from './apikeys.js'
export {
  apiKeysPlugin,
  API_KEYS,
  ApiKeyTenantMismatchError,
  ApiKeyNotAllowedError,
  type ApiKeysPluginOptions,
} from './apikeys-plugin.js'
export {
  authRoutes,
  apiKeyRoutes,
  mfaRoutes,
  DEFAULT_AUTH_RATE_LIMIT,
  ACCOUNT_META,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  type AuthRoutesOptions,
  type PasswordPolicy,
} from './routes.js'
export {
  OAuth,
  googleProvider,
  githubProvider,
  oidcProvider,
  discoverOidcProvider,
  stripTrailingSlashes,
  OAuthProviderUnknownError,
  OAuthStateInvalidError,
  OAuthExchangeError,
  type OAuthProvider,
  type OAuthProfile,
  type OAuthOptions,
} from './oauth.js'
export {
  oauthPlugin,
  oauthRoutes,
  OAUTH,
  type OAuthPluginOptions,
  type OAuthRoutesOptions,
} from './oauth-plugin.js'
export {
  LoginThrottle,
  MemoryThrottleStore,
  AccountLockedError,
  type LoginThrottleOptions,
  type MemoryThrottleStoreOptions,
  type ThrottleStore,
  type ThrottleWindow,
} from './throttle.js'
export { RedisThrottleStore, type RedisThrottleClient, type RedisThrottleStoreOptions } from './redis-throttle.js'

export {
  WebAuthnService,
  MemoryPasskeyStore,
  MemoryWebAuthnChallengeStore,
  WebAuthnChallengeError,
  WebAuthnVerificationError,
  PasskeyNotFoundError,
  PasskeyClonedError,
  PasskeyExistsError,
  WebAuthnSubjectMismatchError,
  type PasskeyCredential,
  type StoredChallenge,
  type PasskeyStore,
  type WebAuthnChallengeStore,
  type WebAuthnVerifier,
  type VerifyRegistrationInput,
  type VerifiedRegistration,
  type VerifyAuthenticationInput,
  type VerifiedAuthentication,
  type WebAuthnConfig,
  type WebAuthnServiceOptions,
  type RegistrationOptions,
  type AuthenticationOptions,
} from './webauthn.js'
export { webauthnPlugin, WEBAUTHN, type WebAuthnPluginOptions } from './webauthn-plugin.js'
