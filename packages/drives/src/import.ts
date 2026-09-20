import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { toView, type Drives } from './drives.js'
import type { DriveItem } from './provider.js'
import type { DriveConnectionView, DriveImportStrategy } from './store.js'

/**
 * Turning one external item into one thing the app owns.
 *
 * The framework stops at the water's edge here, deliberately. It brings the
 * bytes across safely and records that it did; it has **no opinion** about what
 * the document *means*. Quarantine policy, OCR, classification, extraction,
 * approval workflow, retention — all of that is the application's, and RFC 0002
 * says so explicitly. The seam is {@link DriveSink}: one function, whatever the
 * app wants on the other side of it.
 */

/** Hooks emitted by the import pipeline. */
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'drive:item_imported': {
      tenantId: string
      connectionId: string
      externalId: string
      targetId: string
      strategy: DriveImportStrategy
      version: string
    }
    'drive:item_skipped': { tenantId: string; connectionId: string; externalId: string; reason: DriveSkipReason }
  }
}

export type DriveSkipReason =
  /** Already imported at this exact content version. */
  | 'unchanged'
  /** A folder, or an item the filter rejected. */
  | 'filtered'
  /** The provider offers no downloadable bytes and the app did not handle the export. */
  | 'no-content'

/** What a sink is handed. */
export interface DriveSinkInput {
  connection: DriveConnectionView
  item: DriveItem
  /**
   * The bytes — present only under the `copy` strategy.
   *
   * Under `reference` this is absent and **nothing was downloaded**: that is
   * the whole point of the strategy, so no egress is paid and no copy exists.
   */
  content?: { stream: Readable; contentType?: string | undefined; size?: number | undefined }
  /** The content version this import represents; store it if you want your own provenance. */
  version: string
  strategy: DriveImportStrategy
}

/** What the app did with it. */
export interface DriveSinkResult {
  /** The app's own id for the result — a `@basaltkit/files` record id, a document row id. */
  targetId: string
}

/**
 * Where an imported item lands.
 *
 * A plain function rather than an interface with one method: there is exactly
 * one thing to implement, and a function composes (wrap it to add
 * classification, swap it in a test) where an interface would only add a class
 * to write.
 */
export type DriveSink = (input: DriveSinkInput) => Promise<DriveSinkResult>

/**
 * The subset of `@basaltkit/files`' `Files` that {@link filesSink} needs.
 *
 * Structural, so this package does **not** depend on `@basaltkit/files`. A real
 * `Files` instance satisfies it, and an app that keeps documents in its own
 * table can satisfy it too. Same reasoning as the `'tenancy:active'` marker
 * elsewhere in the framework: a signal, not an import.
 */
export interface FileUploadTarget {
  upload(
    content: AsyncIterable<Uint8Array | string>,
    input: {
      name: string
      contentType: string
      tenantId?: string
      uploadedBy?: string
      metadata?: Record<string, never> | Record<string, unknown>
      contentLength?: number
    },
  ): Promise<{ id: string }>
}

/**
 * A sink that streams the item straight into `@basaltkit/files`.
 *
 * This is the composition the whole design is pointed at: `Files.upload`
 * already caps the size mid-stream, hashes with SHA-256 as the bytes pass,
 * sniffs the real type on the first 64 KiB (rejecting bytes that contradict the
 * declared type), enforces the tenant quota and — on a driver with `putStream`
 * — writes straight through to the backend without ever holding the file. None
 * of that is re-implemented here; an external file gets exactly the same
 * treatment an uploaded one does, which is the point.
 */
export function filesSink(files: FileUploadTarget, options: { uploadedBy?: string } = {}): DriveSink {
  return async ({ item, content, connection, version, strategy }) => {
    if (!content) {
      throw new Error(`filesSink cannot handle the "${strategy}" strategy: it has no bytes to store.`)
    }
    const record = await files.upload(content.stream, {
      name: item.name,
      // The declared type is only a starting point — `validate.sniff` overrides
      // it from the bytes and keeps this one as `metadata.declaredType`.
      contentType: content.contentType ?? item.contentType ?? 'application/octet-stream',
      tenantId: connection.tenantId,
      ...(options.uploadedBy !== undefined ? { uploadedBy: options.uploadedBy } : {}),
      ...(content.size !== undefined ? { contentLength: content.size } : {}),
      metadata: {
        driveProvider: connection.provider,
        driveConnectionId: connection.id,
        driveExternalId: item.externalId,
        driveVersion: version,
        ...(item.path !== undefined ? { drivePath: item.path } : {}),
        ...(item.externalUrl !== undefined ? { driveExternalUrl: item.externalUrl } : {}),
      },
    })
    return { targetId: record.id }
  }
}

/**
 * The content identity used for dedup.
 *
 * Preference order is deliberate: a provider `version`/revision changes exactly
 * when the content does, a checksum is content-derived, and `updatedAt` is the
 * last resort because it also moves on a rename or a re-share — re-downloading
 * a gigabyte because someone renamed a folder is a bill, not a feature. When
 * nothing at all is available the item is treated as always-changed, which is
 * the safe direction (a redundant import, never a missed update).
 */
export function contentVersion(item: DriveItem): string {
  if (item.version !== undefined && item.version !== '') return `v:${item.version}`
  if (item.checksum) return `${item.checksum.algorithm}:${item.checksum.value}`
  if (item.updatedAt !== undefined) return `t:${item.updatedAt}:${item.size ?? ''}`
  return `n:${createHash('sha256').update(`${item.externalId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32)}`
}

export interface ImportOptions {
  strategy?: DriveImportStrategy
  tenantId?: string
  /** Decides whether an item is imported at all. Runs before any download. */
  filter?: (item: DriveItem) => boolean
  /** Re-import even when the ledger says this version is already in. */
  force?: boolean
  signal?: AbortSignal
}

export type DriveImportOutcome =
  | { status: 'imported'; targetId: string; version: string }
  | { status: 'skipped'; reason: DriveSkipReason }

/**
 * Imports one item: dedup check, then (for `copy`) stream it through the sink.
 *
 * Ordering matters and is the reason this is not inline in the sync loop: the
 * ledger is consulted **before** the download, so an unchanged file costs one
 * cheap local read instead of its own size in egress. For a nightly sync over a
 * folder that rarely changes, that is the difference between a few kilobytes
 * and the whole corpus, every night.
 */
export async function importItem(
  drives: Drives,
  connectionId: string,
  item: DriveItem,
  sink: DriveSink,
  options: ImportOptions = {},
): Promise<DriveImportOutcome> {
  const strategy: DriveImportStrategy = options.strategy ?? 'copy'
  const { ledger, require, hooks, now } = drives.internals
  const connection = await require(connectionId, options.tenantId, 'importItem')
  const view = toView(connection)

  const skip = async (reason: DriveSkipReason): Promise<DriveImportOutcome> => {
    await hooks?.emit('drive:item_skipped', {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      externalId: item.externalId,
      reason,
    })
    return { status: 'skipped', reason }
  }

  if (item.kind === 'folder') return skip('filtered')
  if (options.filter && !options.filter(item)) return skip('filtered')
  /**
   * An item with no downloadable bytes cannot be copied, and asking the adapter
   * to try produces a terminal `DRIVE_UNSUPPORTED` — which, for a Google Drive
   * full of Docs and Sheets, is a permanently failing import job for every one
   * of them, re-enqueued by every sync because a failure never reaches the
   * ledger. `no-content` was declared as a skip reason in phase 1 for exactly
   * this case and nothing ever emitted it; the second adapter is where it
   * finally has a subject.
   *
   * Only under `copy`: `reference` never opens a byte, so an app that wants to
   * run its own export still gets the item handed to its sink.
   */
  if (strategy === 'copy' && item.exportOnly === true) return skip('no-content')

  const version = contentVersion(item)
  if (!options.force) {
    const seen = await ledger.find(connection.tenantId, connection.id, item.externalId)
    if (seen && seen.version === version) return skip('unchanged')
  }

  let result: DriveSinkResult
  if (strategy === 'reference') {
    // No download at all. The app records where the file lives; the bytes stay
    // the provider's problem, and so does their availability.
    result = await sink({ connection: view, item, version, strategy })
  } else {
    const content = await drives.download(connection.id, item, {
      tenantId: connection.tenantId,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    try {
      result = await sink({ connection: view, item, version, strategy, content })
    } catch (error) {
      // A sink that threw part-way leaves a half-read socket behind; destroying
      // it releases the connection instead of waiting for a timeout.
      content.stream.destroy()
      throw error
    }
  }

  await ledger.record({
    tenantId: connection.tenantId,
    connectionId: connection.id,
    externalId: item.externalId,
    version,
    targetId: result.targetId,
    strategy,
    importedAt: now(),
  })
  await hooks?.emit('drive:item_imported', {
    tenantId: connection.tenantId,
    connectionId: connection.id,
    externalId: item.externalId,
    targetId: result.targetId,
    strategy,
    version,
  })
  return { status: 'imported', targetId: result.targetId, version }
}

