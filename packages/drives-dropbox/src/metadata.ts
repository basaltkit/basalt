import type { DriveChange, DriveItem } from '@basaltkit/drives'

/**
 * Dropbox metadata → the neutral {@link DriveItem}, and the path handling the
 * rest of the adapter depends on.
 */

/** A `files/list_folder` or `files/get_metadata` entry, as far as this adapter reads it. */
export interface DropboxEntry {
  '.tag'?: string
  id?: string
  name?: string
  path_lower?: string
  path_display?: string
  client_modified?: string
  server_modified?: string
  rev?: string
  size?: number
  content_hash?: string
  is_downloadable?: boolean
}

const epoch = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Maps one entry.
 *
 * Three decisions worth stating, because each is a place a vendor difference
 * could have been flattened:
 *
 * - **`version` is `rev`, not a timestamp.** Dropbox's `rev` changes when, and
 *   only when, the content changes; `server_modified` also moves on a move or
 *   a re-share. The dedup ledger prefers `version`, so a rename costs nothing.
 * - **`checksum` is labelled `dropboxContentHash`, not `sha256`.** It is a
 *   block-tree digest (see `content-hash.ts`) and is **not** comparable with
 *   another provider's SHA-256 of the same bytes. Labelling it honestly is what
 *   stops an app from concluding two files differ because two vendors hash
 *   differently.
 * - **`contentType` is absent.** Dropbox reports no media type at all, which is
 *   the contract's best case rather than its worst: `contentType` is documented
 *   as untrusted, and `@basaltkit/files` sniffs the bytes regardless.
 */
export function toDriveItem(entry: DropboxEntry): DriveItem {
  const isFolder = entry['.tag'] === 'folder'
  const createdAt = epoch(entry.client_modified)
  const updatedAt = epoch(entry.server_modified)
  return {
    externalId: entry.id ?? entry.path_lower ?? '',
    name: entry.name ?? '',
    kind: isFolder ? 'folder' : 'file',
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.path_display !== undefined ? { path: entry.path_display } : {}),
    ...(entry.rev !== undefined ? { version: entry.rev } : {}),
    ...(entry.content_hash !== undefined
      ? { checksum: { algorithm: 'dropboxContentHash', value: entry.content_hash } }
      : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    // Paper docs and some Google-backed files exist in the namespace but have
    // no bytes to hand over. The contract has a word for that, so use it rather
    // than letting `download` fail mysteriously later.
    ...(entry.is_downloadable === false ? { exportOnly: true } : {}),
  }
}

/**
 * Maps a delta entry to a change.
 *
 * A `deleted` entry carries **no id** — Dropbox only tells you the path of the
 * thing that used to be there. The contract now says so explicitly
 * ({@link DriveChange}); flattening it into an `externalId` would have made
 * every ledger lookup miss in silence.
 */
export function toDriveChange(entry: DropboxEntry): DriveChange {
  if (entry['.tag'] === 'deleted') {
    const path = entry.path_display ?? entry.path_lower
    return { type: 'removed', ...(path !== undefined ? { path } : {}) }
  }
  return { type: 'upserted', item: toDriveItem(entry) }
}

/**
 * Normalises a folder handle into what Dropbox calls a "path".
 *
 * Dropbox accepts three spellings in the same slot — `""` for the root, a
 * `/Absolute/Path`, and an `id:…` / `ns:…` handle — which is what makes a
 * single opaque `folderId` in the contract honest here. Anything else is
 * prefixed with `/`, so an app that stored `Finance/2026` still works.
 */
export function dropboxPath(handle: string | undefined): string {
  if (handle === undefined) return ''
  const trimmed = handle.trim()
  if (trimmed === '' || trimmed === '/') return ''
  if (trimmed.startsWith('id:') || trimmed.startsWith('ns:') || trimmed.startsWith('rev:')) return trimmed
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/**
 * JSON for the `Dropbox-API-Arg` header.
 *
 * The argument travels in an HTTP **header**, so it has to be ASCII: Dropbox
 * documents that non-ASCII characters must be escaped as `\uXXXX`, and a file
 * named `relatório.pdf` is the common case, not an edge one. `JSON.stringify`
 * already escapes control characters, which is what keeps a filename
 * containing a newline from splitting the header.
 */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
