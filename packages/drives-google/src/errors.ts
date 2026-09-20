import {
  DriveAccessDeniedError,
  DriveCredentialsInvalidError,
  DriveCursorResetError,
  DriveItemNotFoundError,
  DriveProviderError,
  DriveRateLimitedError,
  parseRetryAfter,
  type GuardedResponse,
} from '@basaltkit/drives'

/**
 * Google's error taxonomy, mapped onto the contract's.
 *
 * Google is unusual in one way that matters more than all the others put
 * together:
 *
 * **A Drive throttle is a `403`, not a `429`.** The body says which:
 *
 * ```json
 * {"error":{"code":403,"errors":[{"domain":"usageLimits",
 *   "reason":"userRateLimitExceeded","message":"User Rate Limit Exceeded"}]}}
 * ```
 *
 * Mapping by status code alone — the obvious implementation — turns every
 * throttle into `DRIVE_ACCESS_DENIED`, which {@link isRetryable} treats as
 * terminal. A tenant whose sync merely went too fast would get a permanently
 * failed job and a "the provider refused the operation" message about a
 * condition that clears itself in a second. So the reason is read, and only a
 * genuine permission refusal (`insufficientPermissions` and friends) becomes
 * `DRIVE_ACCESS_DENIED`.
 *
 * The guarded fetch handles `429` and `503` before an adapter sees them; Google
 * does answer `429` occasionally, so that path is live too, but `403` is the one
 * that has to be caught here.
 */

/** Everything that may be echoed from a Google body into an error we serialise. */
const SAFE_REASON = /^[A-Za-z0-9_.-]{1,80}$/

/**
 * `usageLimits` reasons that mean "slow down", not "no".
 *
 * `dailyLimitExceeded` is in the list even though the window is a day: it is
 * still a quota condition rather than a decision about this caller's rights, and
 * the retry policy's own ceiling (`maxRetryAfterMs`, default 60 s) is what stops
 * a worker waiting for it. Treating it as terminal would be the same mistake in
 * the other direction — a permanent failure for something that clears.
 */
const THROTTLE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'dailyLimitExceeded',
  // `quotaExceeded` here is the *usage* quota. Running out of Drive storage on
  // an upload is `storageQuotaExceeded`, which is not in this set and stays a
  // terminal provider error, because waiting does not create disk space.
  'quotaExceeded',
  'RESOURCE_EXHAUSTED',
])

/**
 * Reasons that really are "you may not do this", which no amount of retrying or
 * re-consenting fixes for the object in question.
 */
const PERMISSION_REASONS = new Set([
  'insufficientPermissions',
  'insufficientFilePermissions',
  'appNotAuthorizedToFile',
  'domainPolicy',
  'forbidden',
  'cannotDownloadAbusiveFile',
  'abuse',
  'PERMISSION_DENIED',
])

/**
 * Reasons a `changes.list` gives when the stored `pageToken` has aged out.
 *
 * Google does not publish a distinct code for it: an expired token is simply an
 * invalid value, so this only ever applies to a call that actually carried a
 * cursor ({@link GoogleFailureContext.cursor}). A `400 invalid` from any other
 * endpoint is a bug in the request, not a dead cursor, and must not silently
 * restart a tenant's feed.
 */
const CURSOR_REASONS = new Set([
  'invalid',
  'invalidValue',
  'invalidPageToken',
  'pageTokenInvalid',
  'invalidStartPageToken',
  'notFound',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'badRequest',
])

/**
 * Pulls the first `error.errors[].reason` out of a Google error body.
 *
 * Only a value that looks like Google's own vocabulary is kept. Anything else —
 * an HTML page from a proxy, a stack trace, a message an attacker influenced —
 * becomes `http_<status>`, because this string ends up in `details`, which
 * `@basaltkit/http` serialises into a response body and `@basaltkit/audit`
 * stores. Google's `message` field is free text and is **never** carried.
 */
export function errorReason(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { errors?: { reason?: unknown }[]; status?: unknown } | string
      error_description?: unknown
    }
    const error = parsed?.error
    if (typeof error === 'object' && error !== null) {
      for (const entry of error.errors ?? []) {
        if (typeof entry?.reason === 'string' && SAFE_REASON.test(entry.reason)) return entry.reason
      }
      // The newer google.rpc shape carries no `errors[]`, only a status enum.
      if (typeof error.status === 'string' && SAFE_REASON.test(error.status)) return error.status
    }
    // The OAuth endpoints answer `{"error":"invalid_grant"}` instead.
    if (typeof error === 'string' && SAFE_REASON.test(error)) return error
  } catch {
    /* not JSON — fall through */
  }
  return `http_${status}`
}

export interface GoogleFailureContext {
  provider: string
  connectionId: string
  /** Set when the failure is about one item, so a 404 names it. */
  externalId?: string | undefined
  /**
   * The request carried a change cursor. Only then can an "invalid value" mean
   * the cursor died rather than the request being wrong.
   */
  cursor?: boolean | undefined
  /** `Retry-After`, when the response carried one. */
  retryAfterMs?: number | undefined
}

/**
 * Turns a failed Google response into the contract's error for it.
 *
 * Always consumes the body: a response left unread holds a socket open until the
 * timeout, and an error path is exactly where that is least likely to be
 * noticed. The **URL is never read out of the response or put in an error** — a
 * Drive download URL is a bearer credential.
 */
export async function googleFailure(response: GuardedResponse, context: GoogleFailureContext): Promise<never> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    response.destroy()
  }
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'])
  throw toGoogleError(response.status, body, {
    ...context,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

export function toGoogleError(status: number, body: string, context: GoogleFailureContext): Error {
  const reason = errorReason(body, status)

  if (status === 401) {
    // `authError` / `invalidCredentials`. The engine answers with exactly one
    // reactive refresh before condemning the connection, which is right for
    // both a genuinely dead grant and a token that expired early.
    return new DriveCredentialsInvalidError(context.connectionId, `the provider answered 401 (${reason}).`)
  }

  if (status === 403) {
    // The load-bearing branch. See the note at the top of this file.
    if (THROTTLE_REASONS.has(reason)) return new DriveRateLimitedError(context.retryAfterMs, context.provider)
    if (PERMISSION_REASONS.has(reason)) return new DriveAccessDeniedError(context.provider, reason)
    // An unrecognised 403 is a provider failure, not a permission decision:
    // claiming it is a permission refusal would tell a tenant to fix something
    // that may not be theirs to fix.
    return new DriveProviderError(context.provider, reason, status, false)
  }

  if (status === 429) {
    // The guarded fetch normally intercepts this; kept so a transport that
    // hands one through is still classified correctly rather than becoming an
    // opaque provider error.
    return new DriveRateLimitedError(context.retryAfterMs, context.provider)
  }

  if ((status === 400 || status === 404) && context.cursor === true && CURSOR_REASONS.has(reason)) {
    // The stored `pageToken` has aged out. It is persisted, so mapped to any
    // other error one expiry makes every future sync of this connection fail
    // identically for ever, with no retry policy able to help.
    return new DriveCursorResetError(context.provider, 'the changes pageToken is no longer valid')
  }

  if (status === 404) {
    return new DriveItemNotFoundError(context.provider, context.externalId ?? reason)
  }

  // 5xx never reached a decision, so it is the one class worth retrying.
  return new DriveProviderError(context.provider, reason, status, status >= 500)
}
