import { DriveAccessDeniedError } from '@basaltkit/drives'

/**
 * Which drive a connection is pointed at, and where in it.
 *
 * This is the one place where Microsoft does not fit a single-handle contract
 * the way Dropbox does. Dropbox has exactly one namespace per grant and a
 * `folderId` is a path inside it. Graph has three different things a connection
 * could reasonably mean:
 *
 * - **a personal OneDrive** — `/me/drive`;
 * - **some specific drive** the user can reach, by id — `/drives/{driveId}`,
 *   which is what a *shared* library or a second OneDrive is;
 * - **a SharePoint site's default document library** — `/sites/{siteId}/drive`.
 *
 * Guessing between them from a bare id is not possible: a Graph drive id and a
 * Graph site id are both opaque strings, and picking the wrong one produces a
 * `404 itemNotFound` that looks like a permissions problem. So the target is
 * **explicit**, encoded in the connection's `rootId` with a tiny grammar:
 *
 * | `rootId` | Graph resource |
 * |---|---|
 * | absent, or `me` | `/me/drive/root` |
 * | `drive:{driveId}` | `/drives/{driveId}/root` |
 * | `site:{siteId}` | `/sites/{siteId}/drive/root` |
 * | `item:{itemId}` | `/me/drive/items/{itemId}` |
 * | `drive:{driveId}/item:{itemId}` | `/drives/{driveId}/items/{itemId}` |
 * | `site:{siteId}/item:{itemId}` | `/sites/{siteId}/drive/items/{itemId}` |
 * | a bare Graph item id | `items/{id}` in the connection's own drive |
 *
 * Build one with {@link microsoftRoot} rather than by hand.
 *
 * ## Why the validation is not decoration
 *
 * `rootId` is **caller-controlled**: `driveRoutes()` takes it from `?rootId=`
 * on the connect URL and carries it to `completeAuthorization`. It then becomes
 * part of a Graph request path. A handle containing `/`, `?`, `#` or a
 * percent-escape is therefore an attempt to address a resource the connection
 * was not scoped to — so a handle is accepted only if every segment matches
 * {@link SAFE_ID}, and refused with `DRIVE_ACCESS_DENIED` otherwise. The
 * refusal never echoes the handle back: it is attacker-chosen text and
 * `details` is serialised into the HTTP body.
 */

/**
 * The character set a Graph id may use in a path segment.
 *
 * Deliberately narrower than what a URL allows. Real ids fit comfortably: a
 * drive id is `b!` plus base64url, an item id is uppercase alphanumeric, a site
 * id is `host,guid,guid`. `/`, `?`, `#`, `&`, `%`, `:`, backslash and
 * whitespace are all excluded, which is what makes "a segment" and "a path
 * segment" the same thing.
 *
 * The second pattern is not decoration either: `.` and `..` satisfy every other
 * rule and are the one pair of "ids" a URL resolves *away*, which is how a
 * handle confined to one folder would come to address the drive above it.
 */
const SAFE_ID = /^[A-Za-z0-9!$'()*+,.;=@_~-]{1,512}$/
const DOTS_ONLY = /^\.+$/

/** Whether a value is usable as a Graph id in a request path. */
const safeId = (value: string): boolean => SAFE_ID.test(value) && !DOTS_ONLY.test(value)

/** A parsed connection root. At most one of `driveId`/`siteId` is set. */
export interface MicrosoftRoot {
  /** `/drives/{driveId}` — a specific drive, including a shared document library. */
  driveId?: string | undefined
  /** `/sites/{siteId}/drive` — the site's **default** document library. */
  siteId?: string | undefined
  /** A folder inside the drive. Absent means the drive's root. */
  itemId?: string | undefined
}

/**
 * Builds a `rootId` handle for `drives.connect({ rootId })` or the connect
 * route's `?rootId=`.
 *
 * ```ts
 * microsoftRoot({})                                   // 'me'
 * microsoftRoot({ siteId: 'contoso.sharepoint.com,…' }) // 'site:contoso.sharepoint.com,…'
 * microsoftRoot({ driveId: 'b!abc', itemId: '01XYZ' })  // 'drive:b!abc/item:01XYZ'
 * ```
 */
export function microsoftRoot(input: MicrosoftRoot): string {
  if (input.driveId !== undefined && input.siteId !== undefined) {
    throw new TypeError('microsoftRoot(): pass `driveId` or `siteId`, not both.')
  }
  for (const value of [input.driveId, input.siteId, input.itemId]) {
    if (value !== undefined && !safeId(value)) {
      throw new TypeError('microsoftRoot(): ids may not be "." or ".." and may not contain "/", "?", "#", "%", ":" or whitespace.')
    }
  }
  const drive =
    input.driveId !== undefined ? `drive:${input.driveId}` : input.siteId !== undefined ? `site:${input.siteId}` : 'me'
  return input.itemId !== undefined ? `${drive}/item:${input.itemId}` : drive
}

/**
 * Parses a handle. Refuses anything that could reshape a request path.
 *
 * A bare id with no keyword is read as an item id in the connection's own
 * drive, which is what makes `list({ folderId })` work with the `externalId` of
 * a folder the listing just returned — the common case, and the one an app
 * writes without reading this file.
 */
export function parseMicrosoftRoot(handle: string | undefined, provider: string): MicrosoftRoot {
  if (handle === undefined) return {}
  const trimmed = handle.trim()
  if (trimmed === '' || trimmed === '/' || trimmed === 'me') return {}

  const root: MicrosoftRoot = {}
  for (const segment of trimmed.split('/')) {
    const divider = segment.indexOf(':')
    const keyword = divider === -1 ? '' : segment.slice(0, divider)
    const value = divider === -1 ? segment : segment.slice(divider + 1)
    if (!safeId(value)) throw invalidRootHandle(provider)
    switch (keyword) {
      case 'drive':
        if (root.driveId !== undefined || root.siteId !== undefined) throw invalidRootHandle(provider)
        root.driveId = value
        break
      case 'site':
        if (root.driveId !== undefined || root.siteId !== undefined) throw invalidRootHandle(provider)
        root.siteId = value
        break
      case 'item':
      case '':
        if (root.itemId !== undefined) throw invalidRootHandle(provider)
        root.itemId = value
        break
      default:
        throw invalidRootHandle(provider)
    }
  }
  return root
}

/**
 * The drive a root lives in: `/me/drive`, `/drives/{id}` or
 * `/sites/{id}/drive`. Everything else in the adapter is built from this, so a
 * connection can never address a drive it was not scoped to.
 */
export function driveBase(root: MicrosoftRoot): string {
  if (root.driveId !== undefined) return `/drives/${root.driveId}`
  if (root.siteId !== undefined) return `/sites/${root.siteId}/drive`
  return '/me/drive'
}

/** The resource a root points at: the drive's root folder, or one folder in it. */
export function itemResource(root: MicrosoftRoot): string {
  const base = driveBase(root)
  return root.itemId === undefined ? `${base}/root` : `${base}/items/${root.itemId}`
}

/**
 * The resource for one item **inside** a connection's drive.
 *
 * The drive comes from the connection, never from the item: an `externalId` is
 * only unique within a drive, and letting an item decide which drive to open
 * would be how a connection scoped to one library reads another.
 */
export function itemInDrive(root: MicrosoftRoot, externalId: string, provider: string): string {
  if (!safeId(externalId)) throw invalidRootHandle(provider)
  return `${driveBase(root)}/items/${externalId}`
}

/** Whether a value can be used as a Graph id in a path. */
export function isSafeId(value: string | undefined): value is string {
  return value !== undefined && safeId(value)
}

/**
 * The refusal. No handle in the message and none in `details`: the handle is
 * caller-chosen text, and `details` is serialised into the response body by
 * `@basaltkit/http` and stored by `@basaltkit/audit`.
 */
export function invalidRootHandle(provider: string): Error {
  return new DriveAccessDeniedError(provider, 'the drive handle is not a valid OneDrive/SharePoint root')
}
