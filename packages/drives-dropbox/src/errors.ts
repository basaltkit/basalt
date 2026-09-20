import {
  DriveAccessDeniedError,
  DriveCredentialsInvalidError,
  DriveCursorResetError,
  DriveItemNotFoundError,
  DriveProviderError,
  type GuardedResponse,
} from '@basaltkit/drives'

/**
 * Dropbox's error taxonomy, mapped onto the contract's.
 *
 * Dropbox is unusual in two ways that matter here:
 *
 * 1. **`409` is its normal "no" for endpoint-specific failures.** A missing
 *    file, a path that is a folder, an unsupported operation — all `409` with
 *    a JSON body whose `error_summary` names the case (`path/not_found/…`).
 *    Reading that string is the only way to distinguish "the file is gone" from
 *    "you asked for something impossible", and the difference decides whether
 *    an import job is a retry, a skip, or a bug report.
 * 2. **`401` has two flavours.** `expired_access_token` is routine and answered
 *    by a refresh; `invalid_access_token` usually means the grant is gone. Both
 *    map to {@link DriveCredentialsInvalidError}, which the engine answers with
 *    exactly one reactive refresh before condemning the connection — the right
 *    behaviour for both, because the second is only *usually* terminal.
 *
 * `429` never reaches here: the guarded fetch turns it into
 * `DRIVE_RATE_LIMITED` before an adapter sees the response, with the
 * `retry_after` this module reads out of the body.
 */

/** Everything that may be echoed from a provider body into an error we serialise. */
const SAFE_SUMMARY = /^[A-Za-z0-9_./-]{1,120}$/

/**
 * Pulls Dropbox's `error_summary` out of a response body.
 *
 * Only a value that looks like Dropbox's own taxonomy is kept. Anything else —
 * an HTML error page from a proxy, a stack trace, a body an attacker got to
 * influence — is replaced by `http_<status>`, because this string ends up in
 * `details`, which `@basaltkit/http` serialises into a response and
 * `@basaltkit/audit` stores.
 */
export function errorSummary(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error_summary?: unknown }
    const summary = parsed?.error_summary
    if (typeof summary === 'string' && SAFE_SUMMARY.test(summary)) return summary
  } catch {
    /* not JSON — fall through */
  }
  // Dropbox also answers some auth failures with a bare token string.
  const trimmed = body.trim()
  if (SAFE_SUMMARY.test(trimmed)) return trimmed
  return `http_${status}`
}

/** Reads Dropbox's own retry hint out of a 429/503 body. */
export function retryAfterFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { retry_after?: unknown } }
    const seconds = parsed?.error?.retry_after
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  } catch {
    /* no hint */
  }
  return undefined
}

export interface DropboxFailureContext {
  provider: string
  connectionId: string
  /** Set when the failure is about one item, so a 409 can become a 404. */
  externalId?: string | undefined
}

/**
 * Turns a failed Dropbox response into the contract's error for it.
 *
 * Always consumes the body: a response left unread holds a socket open until
 * the timeout, and an error path is exactly where that is least likely to be
 * noticed.
 */
export async function dropboxFailure(
  response: GuardedResponse,
  context: DropboxFailureContext,
): Promise<never> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    response.destroy()
  }
  throw toDropboxError(response.status, body, context)
}

export function toDropboxError(status: number, body: string, context: DropboxFailureContext): Error {
  const summary = errorSummary(body, status)
  if (status === 401) {
    return new DriveCredentialsInvalidError(context.connectionId, `the provider answered 401 (${summary}).`)
  }
  if (status === 403) return new DriveAccessDeniedError(context.provider, summary)
  if (status === 409) {
    // Two 409s have a precise meaning the engine can act on. Everything else is
    // a terminal provider failure.
    if (summary.startsWith('path/not_found') || summary.startsWith('path_lookup/not_found')) {
      // The item is gone, so an import job should stop rather than retry.
      return new DriveItemNotFoundError(context.provider, context.externalId ?? summary)
    }
    if (summary.startsWith('reset')) {
      // The `list_folder` cursor has aged out. It is persisted, so anything but
      // dropping it fails identically on every future run for ever.
      return new DriveCursorResetError(context.provider, 'the list_folder cursor was reset')
    }
    return new DriveProviderError(context.provider, summary, status, false)
  }
  // 5xx never reached a decision, so it is the one class worth retrying.
  return new DriveProviderError(context.provider, summary, status, status >= 500)
}
