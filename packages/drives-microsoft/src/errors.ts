import {
  DriveAccessDeniedError,
  DriveCredentialsInvalidError,
  DriveCursorResetError,
  DriveItemNotFoundError,
  DriveProviderError,
  type GuardedResponse,
} from '@basaltkit/drives'

/**
 * Microsoft Graph's error taxonomy, mapped onto the contract's.
 *
 * Graph is better behaved than Dropbox here — it uses real HTTP status codes
 * instead of answering `409` for everything — but three of its answers carry
 * meaning that a status code alone does not:
 *
 * 1. **`410 Gone` with `code: "resyncRequired"`.** The delta token is no longer
 *    usable and the feed must be restarted from scratch. The cursor is
 *    *persisted*, so mapping this to anything else makes every future sync of
 *    that connection fail identically for ever, with no retry policy able to
 *    help. This is the case {@link DriveCursorResetError} exists for.
 * 2. **`403` is not `401`.** A missing `Sites.Read.All`, a sensitivity label, a
 *    conditional-access policy or a tenant sharing restriction all answer `403`
 *    with a perfectly valid token. Folding that into "reconnect your account"
 *    tells a tenant to re-consent forever over something re-consenting cannot
 *    fix.
 * 3. **`423 Locked`.** A file being checked out, virus-scanned or co-authored
 *    is a *transient* refusal — the one 4xx worth retrying, so it is the one
 *    4xx mapped to a retryable {@link DriveProviderError}.
 *
 * `429` never reaches here: the guarded fetch turns it into
 * `DRIVE_RATE_LIMITED` before an adapter sees the response. Graph always sends
 * `Retry-After` with a throttle, which is why this adapter declares no
 * `retryAfterFromBody`.
 */

/**
 * Graph error codes are a fixed camelCase vocabulary (`itemNotFound`,
 * `resyncRequired`, `activityLimitReached`). Only something that looks like one
 * is ever forwarded: the code ends up in `details`, which `@basaltkit/http`
 * serialises into the response body and `@basaltkit/audit` stores.
 */
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/

/**
 * Pulls `error.code` out of a Graph error body.
 *
 * `error.message` is **never** forwarded. Graph's messages are free text and
 * routinely quote the request — including, on a download path, a pre-signed URL
 * that is itself a bearer credential. `innerError.request-id` is genuinely
 * useful for a support ticket but has nowhere to go in the contract's error
 * shape, so it stays out of `details` rather than being smuggled into the
 * summary.
 */
export function errorCode(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } }
    const code = parsed?.error?.code
    if (typeof code === 'string' && SAFE_CODE.test(code)) return code
  } catch {
    /* not JSON — an HTML error page from a proxy, a truncated body */
  }
  return `http_${status}`
}

export interface GraphFailureContext {
  provider: string
  connectionId: string
  /** Set when the failure is about one item, so a 404 can name it. */
  externalId?: string | undefined
  /** Set on the change feed, so `410 resyncRequired` is recognised as a cursor reset. */
  delta?: boolean | undefined
}

/**
 * Turns a failed Graph response into the contract's error for it.
 *
 * Always consumes the body: a response left unread holds a socket open until
 * the timeout, and an error path is exactly where that is least likely to be
 * noticed.
 */
export async function graphFailure(response: GuardedResponse, context: GraphFailureContext): Promise<never> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    response.destroy()
  }
  throw toGraphError(response.status, body, context)
}

export function toGraphError(status: number, body: string, context: GraphFailureContext): Error {
  const code = errorCode(body, status)

  if (status === 401) {
    // `InvalidAuthenticationToken` is routine (an access token that expired
    // early, or clock skew) and the engine answers it with exactly one reactive
    // refresh before condemning the connection — the right behaviour whether
    // the grant is gone or not.
    return new DriveCredentialsInvalidError(context.connectionId, `the provider answered 401 (${code}).`)
  }
  if (status === 403) return new DriveAccessDeniedError(context.provider, code)
  if (status === 404) return new DriveItemNotFoundError(context.provider, context.externalId ?? code)
  if (status === 410) {
    // `resyncRequired` is the documented one; any other 410 on the change feed
    // means the same thing operationally — the token we hold is worthless and
    // only re-priming clears it.
    if (code === 'resyncRequired' || context.delta === true) {
      return new DriveCursorResetError(context.provider, 'the delta token requires a resync')
    }
    return new DriveItemNotFoundError(context.provider, context.externalId ?? code)
  }
  if (status === 423) {
    // Locked: checked out, virus-scanned, or being co-authored. Transient.
    return new DriveProviderError(context.provider, code, status, true)
  }
  if (status === 507) {
    // The drive is full. Terminal for this operation; retrying makes it worse.
    return new DriveProviderError(context.provider, code, status, false)
  }
  // 5xx (and 509, Graph's bandwidth ceiling) never reached a decision, so they
  // are the class worth retrying. Everything else is a decision.
  return new DriveProviderError(context.provider, code, status, status >= 500)
}
