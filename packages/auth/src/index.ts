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
  MfaInvalidCodeError,
  MfaNotEnrolledError,
  type AuthOptions,
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
export { authPlugin, AUTH, type AuthPluginOptions } from './plugin.js'
export {
  ApiKeys,
  ScopeRequiredError,
  scopesSatisfy,
  type ApiKeysOptions,
  type IssueApiKeyInput,
  type ApiKeyContext,
} from './apikeys.js'
export { apiKeysPlugin, API_KEYS, type ApiKeysPluginOptions } from './apikeys-plugin.js'
export { authRoutes, apiKeyRoutes, mfaRoutes } from './routes.js'
export {
  OAuth,
  googleProvider,
  githubProvider,
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
export { LoginThrottle, AccountLockedError, type LoginThrottleOptions } from './throttle.js'
