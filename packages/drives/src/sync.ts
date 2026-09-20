import type { Drives } from './drives.js'
import { DriveCursorResetError } from './errors.js'
import type { DriveChange, DriveDelta, DriveItem } from './provider.js'
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

/**
 * An item the provider says is gone.
 *
 * `externalId` and `path` mirror {@link DriveChange}: a vendor reports a
 * deletion by whichever handle it still has, and Dropbox only has the path (a
 * deleted entry carries no id). `targetId` is therefore resolvable only for an
 * id-based removal; a path-based one is reported for the app to correlate
 * against whatever it stored at import time.
 */
export interface DriveRemoval {
  tenantId: string
  connectionId: string
  externalId?: string | undefined
  /** The provider's path for the item, when the deletion is reported by path. */
  path?: string | undefined
  /** What the ledger recorded for it, when it had been imported and the removal named an id. */
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
  /**
   * The provider invalidated the stored cursor and the feed was restarted.
   *
   * The cursor has been dropped, so the next run re-primes from the beginning
   * and the ledger absorbs the repetition. Worth surfacing because a reset that
   * happens every run means something is wrong (a cursor being aged out faster
   * than the sync interval), and a silent full re-walk is an expensive thing to
   * be silent about.
   */
  reset?: boolean
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
  const hasDelta = provider.delta !== undefined && provider.startDelta !== undefined
  /**
   * Whether the stored cursor is one of **ours** (a parked backfill) rather
   * than a provider's. Checked by prefix, separately from decoding it: a parked
   * backfill whose payload is unreadable is still a parked backfill, and
   * falling through to the change feed would hand `provider.delta` a string the
   * engine wrote. Unreadable therefore means "start the enumeration again", not
   * "pretend the enumeration finished".
   */
  const parked = isBackfillCursor(connection.cursor)
  /** Where a backfill that did not finish in one run had got to, when it can be read. */
  const resuming = readBackfill(connection.cursor)
  /**
   * The first run against an adapter whose change feed starts at "now" has to
   * enumerate what is already there, or the tenant's existing corpus is never
   * imported at all: the feed will only ever carry what changes *after* the
   * connection was made. Google Drive is exactly this shape
   * (`changes.getStartPageToken`); Dropbox is not, and says so with
   * {@link DriveProvider.deltaIncludesExisting}.
   *
   * The ordering is the whole correctness argument: the cursor is taken
   * **before** the listing, so anything that changes while the listing runs is
   * re-delivered by the first delta run. At-least-once, which the ledger
   * absorbs. The other order would be at-most-once, which loses files.
   *
   * A backfill that runs out of `maxItems`/`maxPages` **resumes**. It used to
   * clear the cursor and walk again from the top, which is right only for a
   * drive that fits inside one run: a Google Drive with more items than the
   * ceiling re-walked the same first page on every run for ever, never imported
   * anything past it, never reached the change feed, and reported
   * `truncated: true` each time as though it were making progress.
   */
  const backfilling =
    hasDelta && provider.deltaIncludesExisting !== true && (connection.cursor === undefined || parked)
  const useDelta = hasDelta && !backfilling
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

  const handleRemoval = async (change: { externalId?: string | undefined; path?: string | undefined }): Promise<void> => {
    result.seen++
    result.removed++
    // The ledger is keyed by external id. A path-only removal (Dropbox) cannot
    // be resolved here, and is reported without a `targetId` rather than with a
    // wrong one.
    const known =
      change.externalId !== undefined
        ? await ledger.find(connection.tenantId, connection.id, change.externalId)
        : null
    await options.onRemoved?.({
      tenantId: connection.tenantId,
      connectionId: connection.id,
      ...(change.externalId !== undefined ? { externalId: change.externalId } : {}),
      ...(change.path !== undefined ? { path: change.path } : {}),
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
        let delta: DriveDelta
        try {
          delta = await drives.run(
            connection,
            (session) => provider.delta!(session, cursor as string),
            options.signal ? { signal: options.signal } : {},
          )
        } catch (error) {
          if (!(error instanceof DriveCursorResetError)) throw error
          // The cursor is dead. It is persisted, so retrying would fail the
          // same way for ever; the only recovery is to drop it. The run stops
          // here rather than re-walking the whole drive inside a request or a
          // job that was scoped to a delta — the next run starts clean, and
          // `truncated` says there is more to do.
          await persist(undefined, false)
          result.reset = true
          result.truncated = true
          break
        }
        for (const change of delta.changes as DriveChange[]) {
          if (change.type === 'removed') await handleRemoval(change)
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
      // Take the delta cursor first, and hold it: it is only worth anything
      // once the listing behind it has actually finished. On a resumed backfill
      // the cursor taken by the FIRST run is reused rather than re-primed —
      // re-priming would move it past everything that changed while the earlier
      // pages were being walked, which is the at-most-once direction that loses
      // files.
      let primed: string | undefined
      let pageCursor: string | undefined
      if (backfilling) {
        if (resuming !== undefined) {
          primed = resuming.delta
          pageCursor = resuming.list
        } else {
          primed = await drives.run(
            connection,
            (session) => provider.startDelta!(session, { folderId: connection.rootId }),
            options.signal ? { signal: options.signal } : {},
          )
        }
      }

      /** Set only when the walk ran out of pages to ask for, i.e. it finished. */
      let listingComplete = false
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
        if (pageCursor === undefined) {
          listingComplete = true
          break
        }
        if (result.enqueued >= maxItems || page === maxPages - 1) {
          result.truncated = true
          break
        }
      }
      // A plain full listing (an adapter with no change feed at all) has no
      // resumable cursor worth persisting: it restarts from the top and the
      // ledger absorbs the repetition.
      //
      // A *backfill* is different, because it is the one-off enumeration that
      // precedes a feed which will never replay what already exists. It
      // persists the primed delta cursor once the walk has actually finished —
      // switching to the feed half-way through would skip everything the
      // ceiling cut off, and no later run would ever go back for it. When the
      // walk did **not** finish (a ceiling, or an abort), the engine keeps its
      // own resume point instead, so the next run continues the enumeration
      // rather than starting it again.
      const next = backfilling
        ? listingComplete
          ? primed
          : writeBackfill({ delta: primed as string, ...(pageCursor !== undefined ? { list: pageCursor } : {}) })
        : undefined
      await persist(next, true)
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
 * A backfill that has not finished, parked in `connection.cursor`.
 *
 * It holds two things: the delta cursor taken **before** the first listing page
 * (which is what makes the whole backfill at-least-once), and how far the
 * listing has got. Both are provider-opaque strings the engine only ever hands
 * straight back to the adapter that produced them.
 *
 * It lives in `cursor` rather than in a new column because that is the field a
 * durable store already persists, and because an app that looks at it sees an
 * opaque string either way — which `DriveConnection.cursor` already promises it
 * is. The prefix and version are what keep it distinguishable from a provider
 * cursor for ever, including after an adapter changes its own cursor format.
 */
interface BackfillState {
  /** The delta cursor to adopt once the listing finishes. */
  delta: string
  /** Where the listing is up to. Absent means "at the beginning". */
  list?: string | undefined
}

const BACKFILL_PREFIX = 'basalt.drives.backfill.v1:'

/** Whether a stored cursor is the engine's own parked backfill, readable or not. */
function isBackfillCursor(cursor: string | undefined): boolean {
  return cursor !== undefined && cursor.startsWith(BACKFILL_PREFIX)
}

function writeBackfill(state: BackfillState): string {
  return `${BACKFILL_PREFIX}${Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')}`
}

/**
 * Reads a parked backfill, or `undefined` for anything that is not one.
 *
 * `undefined` rather than a throw, for the same reason the Google adapter
 * tolerates an unrecognised walk cursor: the value is already persisted, and a
 * connection must not be stranded on a row it cannot parse. Unreadable means
 * "we do not know how far we got", so the caller re-primes and walks again —
 * repeated metadata reads, which the ledger makes cheap, rather than skipping
 * whatever the unreadable half named.
 */
function readBackfill(cursor: string | undefined): BackfillState | undefined {
  if (cursor === undefined || !cursor.startsWith(BACKFILL_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor.slice(BACKFILL_PREFIX.length), 'base64url').toString('utf8'),
    ) as BackfillState
    if (typeof parsed?.delta !== 'string' || parsed.delta === '') return undefined
    return { delta: parsed.delta, ...(typeof parsed.list === 'string' ? { list: parsed.list } : {}) }
  } catch {
    return undefined
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
