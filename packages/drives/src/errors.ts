import { BasaltError } from '@basaltkit/core'

/**
 * Every error in this package extends {@link BasaltError}, so its `code` is part
 * of the semver contract and apps can branch on it.
 *
 * A deliberate rule runs through the whole file: **no error message, and no
 * `details` payload, ever contains a token, a refresh token, a client secret or
 * an `Authorization` header.** `@basaltkit/http` serialises `details` into the
 * HTTP body and `@basaltkit/audit` stores it, so anything placed there is
 * effectively public. The guarded fetch redacts URLs before they reach an error
 * (a provider download URL is itself a bearer credential — see
 * {@link DriveContentTooLargeError}).
 */

/**
 * Options the provider-failure errors accept.
 *
 * `providerMessage` is the vendor's own human-readable explanation ("missing
 * required scope files.content.read") — the one thing an operator needs to fix
 * a misconfigured app, and exactly the thing that must never reach a client: it
 * is free text the vendor (or whoever sits in front of it) wrote, and Graph's
 * routinely quotes the request URL. So it is carried **only** on the log-only
 * `internalDetails` channel (non-enumerable; read by `@basaltkit/http`'s error
 * reporter and `internalDetailsOf()`), never in `message` or `details`. Pass it
 * through {@link providerMessageOf} first.
 */
export interface DriveProviderErrorOptions {
  providerMessage?: string | undefined
}

/** Attaches the log-only channel, non-enumerable like `HttpError`'s. */
function attachInternal(error: BasaltError, options: DriveProviderErrorOptions | undefined): void {
  if (options?.providerMessage === undefined || options.providerMessage === '') return
  Object.defineProperty(error, 'internalDetails', {
    value: { providerMessage: options.providerMessage },
    enumerable: false,
    writable: false,
    configurable: true,
  })
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g
const URL_LIKE = /\bhttps?:\/\/\S+/gi
const BEARER_LIKE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
/** Long opaque runs — an access token, a refresh token, a signed query. */
const TOKEN_LIKE = /[A-Za-z0-9_\-.~+/=]{40,}/g

/**
 * Makes a provider-supplied explanation safe to log.
 *
 * The primary control is the adapter's **allow-list of sources** — it reads a
 * vendor's structured message field (`error.message`, `user_message.text`),
 * never a raw body. This is defence in depth on top: control and bidi
 * characters stripped, whitespace collapsed, anything shaped like a URL, a
 * bearer/basic credential, a JWT or a long opaque token replaced, and the
 * result truncated to `max` characters. Returns `undefined` for nothing usable.
 */
export function providerMessageOf(text: unknown, max = 500): string | undefined {
  if (typeof text !== 'string') return undefined
  const cleaned = text
    .replace(CONTROL_OR_BIDI, ' ')
    .replace(URL_LIKE, '[url]')
    .replace(BEARER_LIKE, '$1 [redacted]')
    .replace(JWT_LIKE, '[jwt]')
    .replace(TOKEN_LIKE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return undefined
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned
}

/** No provider is registered under that name. */
export class DriveProviderUnknownError extends BasaltError {
  readonly status = 400
  constructor(name: string, known: readonly string[]) {
    super(
      'DRIVE_PROVIDER_UNKNOWN',
      `No drive provider named "${name}" is registered. Registered: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
      { details: { provider: name } },
    )
  }
}

/**
 * The connection does not exist **in this tenant**.
 *
 * A connection that belongs to another tenant produces this same error, not a
 * 403: telling the caller "it exists but is not yours" is itself a cross-tenant
 * disclosure (it turns connection ids into an oracle for which tenants exist).
 */
export class DriveConnectionNotFoundError extends BasaltError {
  readonly status = 404
  constructor(id: string) {
    super('DRIVE_CONNECTION_NOT_FOUND', `No drive connection "${id}".`, { details: { connectionId: id } })
  }
}

/** A call ran with no resolvable tenant while the app is multi-tenant. */
export class DriveTenantRequiredError extends BasaltError {
  readonly status = 400
  constructor(operation: string) {
    super(
      'DRIVE_TENANT_REQUIRED',
      `drives.${operation}() needs a tenant: tenancy is active but there is no tenant in context and no explicit tenantId.`,
    )
  }
}

/** An explicit `tenantId` disagreed with the tenant in context (anti-widening). */
export class DriveTenantMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super(
      'DRIVE_TENANT_MISMATCH',
      'The explicit tenantId does not match the tenant in context. A request cannot reach another tenant’s drive connections.',
    )
  }
}

/**
 * A tenant id equal to the single-tenant store key (`SINGLE_TENANT_SCOPE`).
 * That string keys a single-tenant app's connections, so a tenant carrying it
 * would list, use and disconnect them. The default tenancy grammar can never
 * produce it; a custom one that does must pick another id.
 */
export class DriveTenantReservedError extends BasaltError {
  readonly status = 400
  constructor(reserved: string) {
    super('DRIVE_TENANT_RESERVED', `"${reserved}" is reserved for single-tenant drive connections and cannot be a tenant id.`)
  }
}

/**
 * The stored credentials no longer work and cannot be recovered without the
 * user re-consenting. The connection is marked `invalid` and stops being used.
 */
export class DriveCredentialsInvalidError extends BasaltError {
  readonly status = 401
  constructor(connectionId: string, reason: string, options?: DriveProviderErrorOptions) {
    super(
      'DRIVE_CREDENTIALS_INVALID',
      `Drive connection "${connectionId}" needs to be reconnected: ${reason}`,
      { details: { connectionId, reason } },
    )
    attachInternal(this, options)
  }

  /** Log-only: the provider's own explanation, when the adapter supplied one. */
  declare readonly internalDetails?: { providerMessage: string }
}

/** The authorization callback could not be trusted (bad/expired/replayed state, PKCE mismatch). */
export class DriveAuthorizationInvalidError extends BasaltError {
  readonly status = 400
  constructor(detail: string) {
    super('DRIVE_AUTHORIZATION_INVALID', `Drive authorization could not be completed: ${detail}`)
  }
}

/** The provider asked us to slow down. `retryAfterMs` is its own hint when it gave one. */
export class DriveRateLimitedError extends BasaltError {
  readonly status = 429
  constructor(
    readonly retryAfterMs: number | undefined,
    provider: string,
  ) {
    super('DRIVE_RATE_LIMITED', `Provider "${provider}" is rate limiting this connection.`, {
      details: { provider, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    })
  }
}

/**
 * A URL the framework refused to open — because the host is not on the
 * provider's declared allowlist, because the address it resolves to failed SSRF
 * validation, or because it could not be parsed at all. The primary SSRF
 * control, because provider responses (a `@microsoft.graph.downloadUrl`, a
 * redirect target) are attacker-influenced data, not trusted configuration.
 *
 * It names the **host and a fixed reason, never the URL**. That is not
 * fastidiousness. On this package's hottest path the URL being refused is a
 * pre-signed download URL, which is itself a bearer credential for the file,
 * and this message is forwarded verbatim into `drive:sync_failed`, an app's
 * logger and `@basaltkit/audit`. `@basaltkit/webhooks`' guard quotes the URL it
 * refused — correct for an endpoint an operator configured, wrong for one a
 * provider handed us — so {@link createDriveFetch} re-raises it as this.
 */
export class DriveHostNotAllowedError extends BasaltError {
  readonly status = 502
  /**
   * The host and reason stay in the message and `details` for the log, the
   * `drive:sync_failed` event and the audit trail; an HTTP client only gets
   * the code — naming an internal host it was refused is an SSRF oracle.
   */
  readonly expose = false
  constructor(host: string, provider: string, reason = 'it is not on its allowed-hosts list') {
    super(
      'DRIVE_HOST_NOT_ALLOWED',
      `Provider "${provider}" tried to reach host "${host}", and ${reason}.`,
      { details: { provider, host, reason } },
    )
  }
}

/** A download exceeded the configured byte cap and was abandoned mid-stream. */
export class DriveContentTooLargeError extends BasaltError {
  readonly status = 413
  constructor(maxBytes: number) {
    super('DRIVE_CONTENT_TOO_LARGE', `The provider's response exceeded the ${maxBytes}-byte limit and was abandoned.`, {
      details: { maxBytes },
    })
  }
}

/**
 * The grant is healthy, but the provider refused **this** object or operation.
 *
 * Distinct from {@link DriveCredentialsInvalidError} on purpose, and the
 * distinction was forced by the first real adapter: Dropbox answers `403
 * access_denied` for a team-policy or missing-scope refusal while the token is
 * perfectly valid. Folding that into "reconnect your account" would tell a
 * tenant to re-consent forever over something re-consenting cannot fix.
 */
export class DriveAccessDeniedError extends BasaltError {
  readonly status = 403
  constructor(provider: string, reason: string, options?: DriveProviderErrorOptions) {
    super('DRIVE_ACCESS_DENIED', `Provider "${provider}" refused the operation: ${reason}`, {
      details: { provider, reason },
    })
    attachInternal(this, options)
  }

  /** Log-only: the provider's own explanation, when the adapter supplied one. */
  declare readonly internalDetails?: { providerMessage: string }
}

/** The provider says the item does not exist (any more). */
export class DriveItemNotFoundError extends BasaltError {
  readonly status = 404
  constructor(provider: string, externalId: string) {
    super('DRIVE_ITEM_NOT_FOUND', `Provider "${provider}" has no item "${externalId}".`, {
      details: { provider, externalId },
    })
  }
}

/**
 * A provider failure an adapter mapped but could not classify more precisely.
 *
 * `summary` is the vendor's own taxonomy string (Dropbox's `error_summary`,
 * e.g. `path/not_found/…`) — a fixed vocabulary, never a token, a URL or a
 * header, so it is safe in `details`, which `@basaltkit/http` serialises into
 * the response body and `@basaltkit/audit` stores.
 *
 * `retryable` is what lets a 5xx from the provider be retried while a 4xx is
 * not: every other error in this package is a decision, and {@link isRetryable}
 * treats a `DRIVE_` code as terminal by default.
 */
export class DriveProviderError extends BasaltError {
  readonly status = 502
  constructor(
    provider: string,
    readonly summary: string,
    readonly providerStatus: number,
    readonly retryable: boolean = false,
    options?: DriveProviderErrorOptions,
  ) {
    super('DRIVE_PROVIDER_ERROR', `Provider "${provider}" failed: ${summary}`, {
      details: { provider, summary, providerStatus },
    })
    attachInternal(this, options)
  }

  /** Log-only: the provider's own explanation, when the adapter supplied one. */
  declare readonly internalDetails?: { providerMessage: string }
}

/**
 * The stored change cursor is no longer usable and the feed must be restarted.
 *
 * Every one of the three vendors can say this, and phase 1 had no way to
 * express it: Dropbox answers `409 reset/` when a `list_folder` cursor has
 * aged out, Microsoft Graph answers `410 resyncRequired`, and Google Drive
 * invalidates a `pageToken` the same way. Mapped to any other error, a sync
 * fails on every run for ever — the cursor that caused it is persisted, so
 * nothing ever clears it and no amount of retrying helps.
 *
 * The engine answers by dropping the cursor and stopping the run; the next run
 * re-primes the feed from the start and the import ledger absorbs the
 * repetition, so a reset costs metadata reads rather than a re-download.
 */
export class DriveCursorResetError extends BasaltError {
  readonly status = 409
  constructor(provider: string, detail = 'the change cursor is no longer valid') {
    super('DRIVE_CURSOR_RESET', `Provider "${provider}" needs the change feed restarted: ${detail}.`, {
      details: { provider },
    })
  }
}

/** The provider adapter does not implement an optional capability. */
export class DriveUnsupportedError extends BasaltError {
  readonly status = 501
  constructor(provider: string, capability: string) {
    super('DRIVE_UNSUPPORTED', `Provider "${provider}" does not support "${capability}".`, {
      details: { provider, capability },
    })
  }
}

/** An inbound provider notification failed verification (bad signature, unknown channel, replay). */
export class DriveNotificationInvalidError extends BasaltError {
  readonly status = 400
  constructor(detail: string) {
    super('DRIVE_NOTIFICATION_INVALID', `Drive notification rejected: ${detail}`)
  }
}

/** A stored secret is not a recognisable envelope — treated as corruption, never as plaintext. */
export class DriveSecretMalformedError extends BasaltError {
  readonly status = 500
  constructor(detail: string) {
    super('DRIVE_SECRET_MALFORMED', `Stored drive credentials could not be read: ${detail}`)
  }
}

/** A stored secret was sealed with a key id that is not in the configured key ring. */
export class DriveSecretKeyUnknownError extends BasaltError {
  readonly status = 500
  constructor(keyId: string) {
    super(
      'DRIVE_SECRET_KEY_UNKNOWN',
      `Stored drive credentials were sealed with key "${keyId}", which is not in the configured key ring. ` +
        'Keep retired keys in `keys` so existing connections stay readable after a rotation.',
      { details: { keyId } },
    )
  }
}

/**
 * The stable code of an error, for health stamping: a {@link BasaltError}'s
 * `code`, or `'UNKNOWN'`. Never the message — that can quote provider text.
 *
 * @internal
 */
export function errorCodeOf(error: unknown): string {
  return error instanceof BasaltError ? error.code : 'UNKNOWN'
}

/** The key ring passed to the secret box is unusable. Thrown at configuration time. */
export class DriveSecretKeyInvalidError extends BasaltError {
  constructor(detail: string) {
    super('DRIVE_SECRET_KEY_INVALID', `Invalid drive encryption key ring: ${detail}`)
  }
}
