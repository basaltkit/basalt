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
} from './stores.js'
export {
  Auth,
  publicUser,
  InvalidCredentialsError,
  EmailTakenError,
  RefreshInvalidError,
  RefreshReusedError,
  AuthRequiredError,
  AuthTokenInvalidError,
  UserUpdateUnsupportedError,
  type AuthOptions,
  type TokenPair,
} from './auth.js'
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
export { authRoutes, apiKeyRoutes } from './routes.js'
export { LoginThrottle, AccountLockedError, type LoginThrottleOptions } from './throttle.js'
