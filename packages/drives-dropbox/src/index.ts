/**
 * Public surface of `@basaltkit/drives-dropbox`.
 *
 * A barrel, and nothing else. The adapter itself lives in `provider.ts` so the
 * workspace coverage gate — which excludes `**​/index.ts` on the assumption that
 * a package's `index.ts` is a re-export file — actually measures it. That
 * assumption holds for a satellite whose barrel *is* its driver; it did not
 * hold here, where 400+ lines of OAuth, cursor and signature handling were
 * sitting behind the exclusion.
 */

export {
  DropboxDrive,
  dropboxDrive,
  DROPBOX_MAX_PAGE_SIZE,
  DROPBOX_SINGLE_UPLOAD_MAX_BYTES,
  type DropboxDriveOptions,
} from './provider.js'

export { DropboxContentHash, dropboxContentHash, DROPBOX_BLOCK_BYTES } from './content-hash.js'
export { errorSummary, retryAfterFromBody, toDropboxError } from './errors.js'
export { apiArg, dropboxPath, toDriveChange, toDriveItem, type DropboxEntry } from './metadata.js'
