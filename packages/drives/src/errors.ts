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
 * The stored credentials no longer work and cannot be recovered without the
 * user re-consenting. The connection is marked `invalid` and stops being used.
 */
export class DriveCredentialsInvalidError extends BasaltError {
  readonly status = 401
  constructor(connectionId: string, reason: string) {
    super(
      'DRIVE_CREDENTIALS_INVALID',
      `Drive connection "${connectionId}" needs to be reconnected: ${reason}`,
      { details: { connectionId, reason } },
    )
  }
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
  constructor(provider: string, reason: string) {
    super('DRIVE_ACCESS_DENIED', `Provider "${provider}" refused the operation: ${reason}`, {
      details: { provider, reason },
    })
  }
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
  ) {
    super('DRIVE_PROVIDER_ERROR', `Provider "${provider}" failed: ${summary}`, {
      details: { provider, summary, providerStatus },
    })
  }
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

/** The key ring passed to the secret box is unusable. Thrown at configuration time. */
export class DriveSecretKeyInvalidError extends BasaltError {
  constructor(detail: string) {
    super('DRIVE_SECRET_KEY_INVALID', `Invalid drive encryption key ring: ${detail}`)
  }
}
