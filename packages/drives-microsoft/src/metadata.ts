import type { DriveChange, DriveChecksum, DriveItem } from '@basaltkit/drives'

/**
 * Microsoft Graph `driveItem` → the neutral {@link DriveItem}.
 *
 * Four decisions, each a place a vendor difference could have been flattened.
 */

/** A `driveItem`, as far as this adapter reads one. */
export interface GraphItem {
  id?: string
  name?: string
  size?: number
  eTag?: string
  cTag?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  webUrl?: string
  folder?: { childCount?: number }
  file?: { mimeType?: string; hashes?: GraphHashes }
  /** OneNote notebooks and the like: present in the namespace, no bytes to hand over. */
  package?: { type?: string }
  /**
   * A "Shared with me" shortcut: the item's bytes live in **another drive**,
   * and this connection cannot fetch them.
   */
  remoteItem?: { id?: string; driveId?: string }
  /** A deletion, in a `/delta` feed. */
  deleted?: { state?: string }
  parentReference?: { driveId?: string; id?: string; path?: string; siteId?: string }
  /**
   * A **pre-signed, short-lived URL that is itself a bearer credential**.
   *
   * Read in {@link GraphItem} only so `download` can use it immediately. It is
   * deliberately never copied into {@link DriveItem.raw}: `raw` is handed to
   * app sinks, persisted next to the imported file and serialised into logs, and
   * a credential that lands in any of those places is a credential that leaked.
   */
  '@microsoft.graph.downloadUrl'?: string
}

export interface GraphHashes {
  /** OneDrive **for Business** and SharePoint. Base64, not hex, and not a standard digest. */
  quickXorHash?: string
  /** OneDrive **personal**. Uppercase hex in Graph's own output. */
  sha1Hash?: string
  /** OneDrive **personal**, newer items. Uppercase hex. */
  sha256Hash?: string
}

/** A `/delta` or `/children` page. */
export interface GraphPage {
  value?: GraphItem[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

const epoch = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Picks the checksum, and **labels it honestly**.
 *
 * Graph publishes a different digest depending on what kind of account the
 * drive belongs to, and they are not interchangeable:
 *
 * - **`quickXorHash`** on OneDrive for Business and SharePoint — a Microsoft
 *   block-XOR construction, base64-encoded, with no counterpart anywhere else.
 * - **`sha1Hash` / `sha256Hash`** on personal OneDrive — real digests, but
 *   uppercase hex in Graph's output, so they are lowercased here to match the
 *   contract's "lowercase hex".
 *
 * The consequence is stated in the README and worth repeating: a checksum is
 * comparable **within one provider**, and on Graph only within one account
 * type. An app that compares a `quickXorHash` from a Business drive with a
 * `sha256` from a personal one is comparing two different functions of two
 * different inputs and will conclude the files differ every time.
 *
 * `quickXorHash` is preferred when present because it is the only hash a
 * Business drive publishes at all; a personal drive publishes the other two.
 */
export function toChecksum(hashes: GraphHashes | undefined): DriveChecksum | undefined {
  if (hashes === undefined) return undefined
  if (typeof hashes.quickXorHash === 'string' && hashes.quickXorHash !== '') {
    // Kept in the provider's own base64 encoding: re-encoding it would make it
    // unrecognisable to anyone comparing against Graph directly.
    return { algorithm: 'quickXorHash', value: hashes.quickXorHash }
  }
  if (typeof hashes.sha256Hash === 'string' && hashes.sha256Hash !== '') {
    return { algorithm: 'sha256', value: hashes.sha256Hash.toLowerCase() }
  }
  if (typeof hashes.sha1Hash === 'string' && hashes.sha1Hash !== '') {
    return { algorithm: 'sha1', value: hashes.sha1Hash.toLowerCase() }
  }
  return undefined
}

/**
 * The display path.
 *
 * `parentReference.path` is Graph's own spelling — `/drive/root:/Finance/2026`
 * — where everything before `root:` is addressing and everything after it is
 * the human path. Only the second half is a path an app should show or
 * correlate on, so the prefix is dropped and the item's own name appended.
 */
export function toPath(item: GraphItem): string | undefined {
  const raw = item.parentReference?.path
  if (raw === undefined || item.name === undefined) return undefined
  const marker = raw.indexOf('root:')
  const parent = marker === -1 ? raw : raw.slice(marker + 'root:'.length)
  const decoded = safeDecode(parent)
  const prefix = decoded === '' || decoded === '/' ? '' : decoded.replace(/\/$/, '')
  return `${prefix}/${item.name}`
}

/** Graph percent-encodes path segments; a malformed escape must not throw here. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Maps one `driveItem`.
 *
 * - **`version` is `cTag`, not `eTag`.** Graph bumps `eTag` for *any* change,
 *   including a rename or a permission edit; `cTag` moves only when the content
 *   does. The dedup ledger prefers `version`, so using `eTag` would re-download
 *   a file every time somebody renamed it.
 * - **`contentType` is `file.mimeType`** and is untrusted by contract — Graph
 *   echoes what the uploading client declared, and `@basaltkit/files` sniffs the
 *   bytes regardless.
 * - **`externalUrl` is `webUrl`** — stored and shown, never fetched.
 * - **`raw` carries the drive id and nothing else.** Not the download URL (see
 *   {@link GraphItem}), and not the whole payload: `raw` is persisted by sinks,
 *   and a Graph item carries user names, email addresses and sharing state that
 *   an app did not ask to store.
 */
export function toDriveItem(item: GraphItem): DriveItem {
  const isFolder = item.folder !== undefined
  const path = toPath(item)
  const checksum = toChecksum(item.file?.hashes)
  const version = item.cTag ?? item.eTag
  const createdAt = epoch(item.createdDateTime)
  const updatedAt = epoch(item.lastModifiedDateTime)
  const driveId = item.parentReference?.driveId
  return {
    externalId: item.id ?? '',
    name: item.name ?? '',
    kind: isFolder ? 'folder' : 'file',
    ...(item.file?.mimeType !== undefined ? { contentType: item.file.mimeType } : {}),
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.parentReference?.id !== undefined ? { parentId: item.parentReference.id } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(checksum !== undefined ? { checksum } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(item.webUrl !== undefined ? { externalUrl: item.webUrl } : {}),
    // Two kinds of entry have **no directly downloadable bytes**, which is
    // exactly what the contract's `exportOnly` means:
    //
    // - a `package` facet (a OneNote notebook), which has no export either;
    // - a `remoteItem` facet — a "Shared with me" shortcut whose bytes live in
    //   somebody else's drive, and a connection is confined to one drive.
    //
    // Saying so is not cosmetic. `importItem` skips an `exportOnly` item under
    // the `copy` strategy with `reason: 'no-content'`; without the flag each
    // one becomes an import job that fails, re-enqueues and fails again for
    // ever, on every sync, for as long as the shortcut exists.
    ...(item.package !== undefined || item.remoteItem !== undefined ? { exportOnly: true } : {}),
    ...(driveId !== undefined ? { raw: { driveId } } : {}),
  }
}

/**
 * Maps one `/delta` entry.
 *
 * Graph reports a deletion as the item's own id plus a `deleted` facet, which
 * is the shape the import ledger is keyed by — so unlike Dropbox, this adapter
 * never needs the contract's path-only removal. The id is what makes
 * `DriveRemoval.targetId` resolvable here and `undefined` there.
 */
export function toDriveChange(item: GraphItem): DriveChange {
  if (item.deleted !== undefined) {
    const externalId = item.id
    return { type: 'removed', ...(externalId !== undefined ? { externalId } : {}) }
  }
  return { type: 'upserted', item: toDriveItem(item) }
}

/** Strips leading and trailing dots in linear time. */
function trimDots(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '.') start++
  while (end > start && value[end - 1] === '.') end--
  return value.slice(start, end)
}

/**
 * A filename, made safe for a Graph path.
 *
 * Graph refuses `" * : < > ? / \ |`, leading or trailing whitespace, and names
 * starting with `~$`. Refused rather than escaped: a name is a name, and a
 * separator inside one is either a bug or an attempt to write outside the
 * folder the upload was scoped to.
 */
export function sanitizeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f"*:<>?/\\|]/g, '_')
    .replace(/^~\$/, '_')
  // A leading dot makes a hidden file on every platform that will later hold
  // the imported copy, and `.`/`..` are not names at all. Trailing dots are
  // trimmed too — Graph refuses them. Both are done with a linear scan: an
  // anchored `\.+$` backtracks polynomially on a name of many dots
  // (CodeQL js/polynomial-redos), and a filename is attacker-supplied.
  const leading = cleaned.startsWith('.') ? `_${trimDots(cleaned)}` : trimDots(cleaned)
  const trimmed = leading.trim()
  return trimmed === '' ? 'file' : trimmed.slice(0, 255)
}
