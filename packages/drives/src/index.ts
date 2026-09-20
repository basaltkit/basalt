export {
  DriveProviderUnknownError,
  DriveConnectionNotFoundError,
  DriveTenantRequiredError,
  DriveTenantMismatchError,
  DriveCredentialsInvalidError,
  DriveAuthorizationInvalidError,
  DriveRateLimitedError,
  DriveHostNotAllowedError,
  DriveContentTooLargeError,
  DriveUnsupportedError,
  DriveNotificationInvalidError,
  DriveSecretMalformedError,
  DriveSecretKeyUnknownError,
  DriveSecretKeyInvalidError,
} from './errors.js'

export {
  DriveSecretBox,
  safeEqual,
  randomToken,
  type DriveEncryptionKey,
  type DriveSecretContext,
} from './secret-box.js'

export {
  createDriveFetch,
  hostAllowed,
  parseRetryAfter,
  capStream,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type GuardedFetch,
  type GuardedRequestInit,
  type GuardedResponse,
  type DriveFetchOptions,
  type Transport,
} from './fetch.js'

export type {
  DriveProvider,
  DriveAuthorization,
  DriveAuthorizeInput,
  DriveExchangeInput,
  DriveRefreshInput,
  DriveAccount,
  DriveTokens,
  DriveSession,
  DriveItem,
  DriveChecksum,
  DrivePage,
  DriveChange,
  DriveDelta,
  DriveContent,
  DriveListOptions,
  DriveUploadInput,
  DriveWatch,
  DriveWatchInput,
  DriveNotificationInput,
  DriveNotificationResult,
} from './provider.js'

export {
  MemoryDriveConnectionStore,
  MemoryDriveImportLedger,
  type DriveConnection,
  type DriveConnectionAccount,
  type DriveConnectionListFilter,
  type DriveConnectionPatch,
  type DriveConnectionStatus,
  type DriveConnectionStore,
  type DriveConnectionView,
  type DriveConnectionWatch,
  type DriveImportLedger,
  type DriveImportRecord,
  type DriveImportStrategy,
} from './store.js'

export {
  DriveCredentials,
  DEFAULT_REFRESH_SKEW_MS,
  type ActiveCredentials,
  type CredentialsOptions,
} from './credentials.js'

export {
  DriveAuthorizationFlow,
  assertRedirectUri,
  challengeFor,
  DEFAULT_STATE_TTL_MS,
  type DriveAuthorizationStart,
  type DriveAuthorizationState,
  type StartAuthorizationInput,
  type CompleteAuthorizationInput,
} from './authorization.js'

export {
  withRetry,
  isRetryable,
  type DriveRetryPolicy,
} from './retry.js'

export {
  Drives,
  toView,
  SINGLE_TENANT_SCOPE,
  type DrivesOptions,
  type ConnectInput,
  type DisconnectOptions,
} from './drives.js'

export {
  importItem,
  filesSink,
  contentVersion,
  type DriveSink,
  type DriveSinkInput,
  type DriveSinkResult,
  type DriveSkipReason,
  type DriveImportOutcome,
  type ImportOptions,
  type FileUploadTarget,
} from './import.js'

export {
  syncConnection,
  dueConnections,
  type DriveEnqueue,
  type DriveImportTask,
  type DriveRemoval,
  type DriveSyncResult,
  type SyncOptions,
} from './sync.js'

export {
  handleNotification,
  watchConnection,
  verifyHmacSignature,
  MemoryReplayGuard,
  type DriveNotificationOutcome,
  type HandleNotificationOptions,
  type NotificationReplayGuard,
} from './notifications.js'

export { drivesPlugin, DRIVES, type DrivesPluginOptions } from './plugin.js'
