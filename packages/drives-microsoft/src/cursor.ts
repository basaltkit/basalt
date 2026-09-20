import { DriveAccessDeniedError, DriveCursorResetError } from '@basaltkit/drives'

/**
 * Cursors, and why Graph needs a wrapper where Dropbox needed none.
 *
 * Dropbox hands back a `cursor` — a token. Graph hands back
 * `@odata.nextLink` and `@odata.deltaLink`, which are **complete URLs**,
 * query string and all, that you are expected to GET verbatim. Two problems
 * follow from that, and both are solved here rather than in the engine:
 *
 * 1. **A URL is not an opaque token.** The contract says a cursor is opaque to
 *    everything above the adapter, and it is stored in the connection row and
 *    returned in `DriveSyncResult.cursor`. Storing a raw provider URL there
 *    leaks Graph's internal paging state into an app's database and its logs,
 *    and invites an app to "just fetch the cursor". So the URL is base64url-ed
 *    behind a prefix: still opaque, still resumable, and obviously not
 *    something to open.
 * 2. **We are about to fetch a URL the provider chose.** That is the exact
 *    shape RFC 0002 §5.1 calls the primary risk. The guarded fetch re-validates
 *    it — host allowlist, SSRF, IP pinning — and this module adds a cheap
 *    pre-check so a cursor that does not even point at Graph is refused before
 *    a socket is opened, and refused with a code an operator can act on rather
 *    than a generic parse failure.
 */

/** A `@odata.nextLink` from a `/children` listing. */
const LIST_PREFIX = 'basalt.msgraph.list:'
/** "The delta feed has not started yet" — see the note in `index.ts`. */
export const DELTA_START_PREFIX = 'basalt.msgraph.delta.start:'
/** A `@odata.nextLink` or `@odata.deltaLink` from a `/delta` feed. */
const DELTA_PREFIX = 'basalt.msgraph.delta:'

/** Wraps a provider URL as an opaque listing cursor. */
export const sealListCursor = (url: string): string => `${LIST_PREFIX}${encode(url)}`
/** Wraps a provider URL as an opaque delta cursor. */
export const sealDeltaCursor = (url: string): string => `${DELTA_PREFIX}${encode(url)}`
/** Marks a delta feed that has not been opened yet, remembering which resource it is for. */
export const sealDeltaStart = (resource: string): string => `${DELTA_START_PREFIX}${encode(resource)}`

/** Whether a delta cursor is the synthetic "not started" marker. */
export const isDeltaStart = (cursor: string): boolean => cursor.startsWith(DELTA_START_PREFIX)

/**
 * Reads the resource out of a "not started" delta cursor.
 *
 * The resource was produced by this adapter from the connection's own root, so
 * it is re-validated only against the shape it must have — a Graph path — and
 * never used to reach a different host.
 */
export function openDeltaStart(cursor: string, provider: string): string {
  const resource = decode(cursor.slice(DELTA_START_PREFIX.length))
  if (resource === undefined || !resource.startsWith('/') || /[?#\s]/.test(resource)) {
    throw new DriveCursorResetError(provider, 'the stored delta cursor is not readable')
  }
  return resource
}

/**
 * Unwraps a listing or delta cursor back into the URL to fetch.
 *
 * Three ways this refuses, and each is a different failure:
 *
 * - **A cursor that is not ours** (an app invented one, a cursor from another
 *   provider survived a migration) — `DRIVE_ACCESS_DENIED`, because it is a
 *   caller error and no amount of retrying fixes it.
 * - **A cursor that is ours but unreadable** — `DRIVE_CURSOR_RESET`, because a
 *   corrupt persisted cursor has exactly the same cure as an expired one: drop
 *   it and re-prime. Anything else fails every future run of that connection
 *   for ever.
 * - **A cursor pointing somewhere other than Graph** — `DRIVE_ACCESS_DENIED`.
 *   The guarded fetch would refuse it a moment later anyway; refusing here
 *   names the real reason instead of "host not allowed", and does it without
 *   a DNS lookup.
 */
export function openLinkCursor(cursor: string, kind: 'list' | 'delta', host: string, provider: string): string {
  const prefix = kind === 'list' ? LIST_PREFIX : DELTA_PREFIX
  if (!cursor.startsWith(prefix)) {
    throw new DriveAccessDeniedError(provider, `the ${kind} cursor was not produced by this adapter`)
  }
  const url = decode(cursor.slice(prefix.length))
  if (url === undefined) {
    throw kind === 'delta'
      ? new DriveCursorResetError(provider, 'the stored delta cursor is not readable')
      : new DriveAccessDeniedError(provider, 'the list cursor is not readable')
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw kind === 'delta'
      ? new DriveCursorResetError(provider, 'the stored delta cursor is not a URL')
      : new DriveAccessDeniedError(provider, 'the list cursor is not a URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== host) {
    // Never echo the URL: a cursor is caller-supplied on this path, and an
    // error's `details` is serialised into the response body.
    throw new DriveAccessDeniedError(provider, `the ${kind} cursor does not point at Microsoft Graph`)
  }
  return parsed.toString()
}

const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

/** Decodes, and refuses anything that does not round-trip — a truncated cursor is not a URL. */
function decode(value: string): string | undefined {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  return Buffer.from(decoded, 'utf8').toString('base64url') === value ? decoded : undefined
}
