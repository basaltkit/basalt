import type { DriveItem } from '@basaltkit/drives'

/**
 * Google Drive `files` resources → the neutral {@link DriveItem}.
 *
 * Google is a partial-response API: nothing comes back unless it is named in
 * `fields`. That is a feature here — the adapter asks for exactly the fields the
 * contract can carry, and nothing else, so a tenant's file titles are the most
 * sensitive thing that ever crosses the wire.
 */

/** A `files` resource, as far as this adapter reads it. */
export interface GoogleFile {
  id?: string
  name?: string
  mimeType?: string
  parents?: string[]
  size?: string
  md5Checksum?: string
  headRevisionId?: string
  version?: string
  createdTime?: string
  modifiedTime?: string
  webViewLink?: string
  trashed?: boolean
  explicitlyTrashed?: boolean
  driveId?: string
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
}

/** A `changes` resource. */
export interface GoogleChange {
  fileId?: string
  removed?: boolean
  file?: GoogleFile
  changeType?: string
  time?: string
  driveId?: string
}

/** Google's folder type. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
/** Everything Docs/Sheets/Slides/Forms/… shares. These files have no bytes. */
export const NATIVE_MIME_PREFIX = 'application/vnd.google-apps.'
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/**
 * The `fields` mask every metadata read uses.
 *
 * `size` and `md5Checksum` are requested even though a Google-native Doc never
 * has them: their **absence** is the signal, and asking for them is how the
 * adapter learns it rather than guessing from the mime type alone.
 */
export const FILE_FIELDS =
  'id,name,mimeType,parents,size,md5Checksum,headRevisionId,createdTime,modifiedTime,webViewLink,trashed,explicitlyTrashed,driveId,shortcutDetails(targetId,targetMimeType)'

const epoch = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Whether a mime type is one of Google's own, editor-backed documents. */
export function isNativeDoc(mimeType: string | undefined): boolean {
  return (
    mimeType !== undefined &&
    mimeType.startsWith(NATIVE_MIME_PREFIX) &&
    mimeType !== FOLDER_MIME &&
    mimeType !== SHORTCUT_MIME
  )
}

/**
 * Maps one file.
 *
 * Four decisions, each a place a vendor difference could have been flattened:
 *
 * - **`version` is `headRevisionId`, not Google's `version` field.** Drive's
 *   `version` is a monotonic counter that moves on *any* change, a rename
 *   included; `headRevisionId` moves only when the bytes do. Since
 *   `contentVersion()` prefers `version` over the checksum, using Drive's
 *   counter would re-download a file every time someone renamed it. A file with
 *   no `headRevisionId` (a native Doc, a folder) falls through to the checksum,
 *   which is content-exact, and then to `updatedAt`.
 * - **`checksum` is labelled `md5`, honestly.** Google publishes an MD5 of the
 *   stored bytes for binary files, and only for those. It is comparable with
 *   anyone else's MD5 of the same bytes, which is exactly why it must not be
 *   labelled anything else.
 * - **A native Doc is `exportOnly`.** Docs, Sheets, Slides and friends have no
 *   `md5Checksum`, no `size` and no downloadable bytes at all: `files.get
 *   ?alt=media` answers `403 fileNotDownloadable`. They are surfaced with
 *   `exportOnly: true` and their mime type in `raw`, so an app can decide to
 *   run `files.export` itself. Silently exporting them to some format the app
 *   never asked for would be the framework inventing a business decision.
 * - **There is no `path`.** Drive is a graph, not a tree: a file can have
 *   several parents, and a "path" is a display convention the API does not
 *   publish. `parentId` carries the first parent; anything path-shaped would be
 *   a fabrication, and the removal-by-path shape Dropbox needs is therefore not
 *   used here.
 */
export function toDriveItem(file: GoogleFile): DriveItem {
  const mimeType = file.mimeType
  const isFolder = mimeType === FOLDER_MIME
  const native = isNativeDoc(mimeType)
  const size = file.size !== undefined ? Number(file.size) : undefined
  const createdAt = epoch(file.createdTime)
  const updatedAt = epoch(file.modifiedTime)
  const raw: Record<string, unknown> = {}
  if (mimeType !== undefined) raw['mimeType'] = mimeType
  if (native) raw['exportOnly'] = true
  if (file.trashed === true) raw['trashed'] = true
  if (file.driveId !== undefined) raw['driveId'] = file.driveId
  if (file.shortcutDetails?.targetId !== undefined) raw['shortcutTargetId'] = file.shortcutDetails.targetId

  return {
    externalId: file.id ?? '',
    name: file.name ?? '',
    kind: isFolder ? 'folder' : 'file',
    // Never trusted by the contract — Drive echoes what the uploading client
    // declared — and deliberately still reported, because it is what lets an
    // app filter before it downloads.
    ...(mimeType !== undefined ? { contentType: mimeType } : {}),
    ...(size !== undefined && Number.isFinite(size) ? { size } : {}),
    ...(file.parents?.[0] !== undefined ? { parentId: file.parents[0] } : {}),
    ...(file.headRevisionId !== undefined ? { version: file.headRevisionId } : {}),
    ...(file.md5Checksum !== undefined ? { checksum: { algorithm: 'md5', value: file.md5Checksum } } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    // Stored and shown, never fetched: a provider-controlled URL used as a
    // request target is an SSRF sink.
    ...(file.webViewLink !== undefined ? { externalUrl: file.webViewLink } : {}),
    ...(native ? { exportOnly: true } : {}),
    raw,
  }
}

/**
 * Whether a change means "this item is gone" rather than "this item changed".
 *
 * Two shapes mean it, and only one of them carries any metadata:
 *
 * - `removed: true` — permanently deleted, or the user lost access. The change
 *   carries a `fileId` and **no `file` resource at all**, which is what makes a
 *   root-scoped connection unable to tell whether it was even in scope.
 * - `file.trashed: true` — the ordinary Drive delete. The full resource is
 *   still there, parents included, so it can be scoped like any other change.
 */
export function isRemoval(change: GoogleChange): boolean {
  return change.removed === true || change.file?.trashed === true
}
