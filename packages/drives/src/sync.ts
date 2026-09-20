import type { Drives } from './drives.js'
import type { DriveChange, DriveItem } from './provider.js'
import type { DriveConnection, DriveImportStrategy } from './store.js'

/**
 * Incremental sync.
 *
 * The single most important property here is what this function **does not
 * do**: it never downloads anything. It walks the provider's change feed (or,
 * for a provider without one, its folder listing), decides what is new, and
 * hands each item to `enqueue`. Downloads happen later, one job per item.
 *
 * That is the answer to "an HTTP request must never block on thousands of
 * files". A connect-and-sync request finishes in the time it takes to read a
 * few pages of metadata, whatever the size of the drive behind it; the actual
 * import runs on the app's queue with its own concurrency, retries and DLQ.
 *
 * ## Delta vs. full walk — what the providers actually offer
 *
 * All three targets do support incremental change detection, with different
 * vocabulary, which is why the contract exposes a single opaque cursor:
 *
 * - **Google Drive** — `changes.getStartPageToken` then `changes.list`, paging
 *   on `nextPageToken` and finishing with `newStartPageToken`.
 * - **Microsoft Graph (OneDrive/SharePoint)** — `/delta` on a drive or folder,
 *   paging on `@odata.nextLink` and finishing with `@odata.deltaLink`.
 * - **Dropbox** — `files/list_folder` then `files/list_folder/continue`, with
 *   `cursor`/`has_more`.
 *
 * An adapter that implements `startDelta` + `delta` gets incremental sync; one
 * that does not falls back to a paginated full listing, which still dedups
 * correctly through the ledger — it just costs more metadata reads.
 */

/** One item the sync decided should be imported. */
export interface DriveImportTask {
  tenantId: string
  connectionId: string
  provider: string
  item: DriveItem
  strategy: DriveImportStrategy
}

/** Where discovered work goes. Wire it to `@basaltkit/queue`; defaults to running inline. */
export type DriveEnqueue = (task: DriveImportTask) => Promise<void>

/** An item the provider says is gone. */
export interface DriveRemoval {
  tenantId: string
  connectionId: string
  externalId: string
  /** What the ledger recorded for it, when it had been imported. */
  targetId?: string | undefined
}

export interface SyncOptions {
  tenantId?: string
  strategy?: DriveImportStrategy
  /** Where to send discovered items. Required in production; see {@link DriveEnqueue}. */
  enqueue: DriveEnqueue
  /**
   * Called for items the provider reports as deleted.
   *
   * The framework does **not** delete anything on its own: whether a removal at
   * the provider should delete the app's copy is a retention decision, and
   * retention is a legal question the framework has no business answering. It
   * reports, the app decides.
   */
  onRemoved?: (removal: DriveRemoval) => Promise<void> | void
  /** Runs before enqueueing. Folders are always skipped. */
  filter?: (item: DriveItem) => boolean
  /**
   * Most items enqueued in one run. Default 1000.
   *
   * A hard bound, not a hint: the first sync of a mature Google Drive can be
   * hundreds of thousands of items, and a loop with no ceiling is how one
   * tenant's connect request becomes an outage. The cursor is persisted as the
   * run goes, so the next run picks up exactly where this one stopped.
   */
  maxItems?: number
  /** Pages read in one run. Default 50. */
  maxPages?: number
  signal?: AbortSignal
}

export interface DriveSyncResult {
  connectionId: string
  /** Items the provider reported. */
  seen: number
  /** Items handed to `enqueue`. */
  enqueued: number
  /** Items the filter or the folder rule rejected. */
  skipped: number
  /** Removals reported. */
  removed: number
  /** The run stopped on `maxItems`/`maxPages` and there is more to read. */
  truncated: boolean
  /** Whether the provider's change feed was used, or a full listing. */
  mode: 'delta' | 'listing'
  cursor?: string | undefined
}

/** Hooks emitted by the sync engine. */
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'drive:sync_started': { tenantId: string; connectionId: string; provider: string; mode: 'delta' | 'listing' }
    'drive:sync_completed': DriveSyncResult & { tenantId: string; provider: string }
    'drive:sync_failed': { tenantId: string; connectionId: string; provider: string; reason: string }
  }
}

/**
 * Runs one sync pass over a connection.
 *
 * Never throws for a provider hiccup that the retry policy already handled —
 * but a terminal failure (invalid credentials, an unsupported capability) does
 * propagate, because a sync that quietly does nothing forever is worse than one
 * that fails visibly.
 */
export async function syncConnection(
  drives: Drives,
  connectionId: string,
  options: SyncOptions,
): Promise<DriveSyncResult> {
  const { require, store, ledger, hooks, now } = drives.internals
  const connection = await require(connectionId, options.tenantId, 'sync')
  const provider = drives.internals.provider(connection.provider)
  const strategy: DriveImportStrategy = options.strategy ?? 'copy'
  const maxItems = options.maxItems ?? 1000
  const maxPages = options.maxPages ?? 50
  const useDelta = provider.delta !== undefined && provider.startDelta !== undefined
  const mode: 'delta' | 'listing' = useDelta ? 'delta' : 'listing'

  await hooks?.emit('drive:sync_started', {
    tenantId: connection.tenantId,
    connectionId: connection.id,
    provider: connection.provider,
    mode,
  })

  const result: DriveSyncResult = {
    connectionId: connection.id,
    seen: 0,
    enqueued: 0,
    skipped: 0,
    removed: 0,
    truncated: false,
    mode,
  }

  const handleItem = async (item: DriveItem): Promise<void> => {
    result.seen++
    if (item.kind === 'folder' || (options.filter && !options.filter(item))) {
      result.skipped++
      return
    }
    await options.enqueue({
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      item,
      strategy,
    })
    result.enqueued++
  }

  const handleRemoval = async (externalId: string): Promise<void> => {
    result.seen++
    result.removed++
    const known = await ledger.find(connection.tenantId, connection.id, externalId)
    await options.onRemoved?.({
      tenantId: connection.tenantId,
      connectionId: connection.id,
      externalId,
      ...(known ? { targetId: known.targetId } : {}),
    })
  }

  try {
    let cursor = connection.cursor
    let revision = connection.revision

    /** Persists progress after every page, so a crash costs one page, not the run. */
    const persist = async (next: string | undefined, synced: boolean): Promise<void> => {
      const updated = await store.update(
        connection.tenantId,
        connection.id,
        { cursor: next, ...(synced ? { lastSyncedAt: now() } : {}) },
        revision,
      )
      if (updated) {
        revision = updated.revision
        cursor = next
      }
    }

    if (useDelta) {
      if (cursor === undefined) {
        cursor = await drives.run(
          connection,
          (session) => provider.startDelta!(session, { folderId: connection.rootId }),
          options.signal ? { signal: options.signal } : {},
        )
        await persist(cursor, false)
      }
      for (let page = 0; page < maxPages; page++) {
        if (options.signal?.aborted) break
        const delta = await drives.run(
          connection,
          (session) => provider.delta!(session, cursor as string),
          options.signal ? { signal: options.signal } : {},
        )
        for (const change of delta.changes as DriveChange[]) {
          if (change.type === 'removed') await handleRemoval(change.externalId)
          else await handleItem(change.item)
        }
        await persist(delta.cursor, true)
        if (!delta.hasMore) break
        if (result.enqueued >= maxItems || page === maxPages - 1) {
          result.truncated = true
          break
        }
      }
    } else {
      let pageCursor: string | undefined
      for (let page = 0; page < maxPages; page++) {
        if (options.signal?.aborted) break
        const listed = await drives.run(
          connection,
          (session) =>
            provider.list(session, {
              ...(connection.rootId !== undefined ? { folderId: connection.rootId } : {}),
              ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
            }),
          options.signal ? { signal: options.signal } : {},
        )
        for (const item of listed.items) await handleItem(item)
        pageCursor = listed.cursor
        if (pageCursor === undefined) break
        if (result.enqueued >= maxItems || page === maxPages - 1) {
          result.truncated = true
          break
        }
      }
      // A full listing has no resumable cursor worth persisting across runs —
      // it restarts from the top and the ledger absorbs the repetition.
      await persist(undefined, true)
    }

    result.cursor = cursor
    await hooks?.emit('drive:sync_completed', { ...result, tenantId: connection.tenantId, provider: connection.provider })
    return result
  } catch (error) {
    await hooks?.emit('drive:sync_failed', {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      provider: connection.provider,
      // The message only — never the error object, which for a provider failure
      // can carry a request URL, and a provider download URL is itself a bearer
      // credential.
      reason: error instanceof Error ? error.message : 'unknown error',
    })
    throw error
  }
}

/**
 * Connections that a scheduled sweep should visit.
 *
 * Exposed separately so an app can feed it to `defineReconciler` from
 * `@basaltkit/scheduler` — which already solves overlap guarding, the
 * cross-replica lease and per-item error isolation — rather than this package
 * growing its own scheduler:
 *
 *     defineReconciler({
 *       name: 'drive-sync',
 *       every: '15m',
 *       find: () => dueConnections(drives, { tenantId, staleFor: '15m' }),
 *       redispatch: (c) => SyncDrive.dispatch({ connectionId: c.id, tenantId: c.tenantId }),
 *     }).schedule(scheduler)
 */
export async function dueConnections(
  drives: Drives,
  options: { tenantId: string; staleForMs?: number; provider?: string; limit?: number },
): Promise<DriveConnection[]> {
  const staleFor = options.staleForMs ?? 15 * 60_000
  const cutoff = drives.internals.now() - staleFor
  const all = await drives.internals.store.list(options.tenantId, {
    status: 'active',
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  })
  return all
    .filter((connection) => connection.lastSyncedAt === undefined || connection.lastSyncedAt <= cutoff)
    .slice(0, options.limit ?? 100)
}
