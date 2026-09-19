import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, runWithContext, tryCtx } from '@basaltkit/core'
import { EVENTS } from './index.js'

/**
 * The transactional outbox pattern: domain events are first written to a
 * durable store (ideally in the same transaction as the state change), then a
 * relay delivers them to external systems and marks them published. Delivery is
 * **at-least-once** and survives crashes — nothing is lost between "committed"
 * and "delivered".
 */
export interface OutboxEntry {
  id: string
  event: string
  payload: unknown
  tenantId?: string
  createdAt: number
  attempts: number
  publishedAt?: number
  lastError?: string
}

/**
 * Narrows {@link OutboxStore.pending} so the relay can look past tenants it is
 * not going to dispatch right now (a tenant at its in-flight cap, or one whose
 * backlog already fills the batch). A store may ignore it — the outbox re-filters
 * every row — but then fairness degrades to what one oldest-first page holds.
 */
export interface OutboxPendingFilter {
  /** Skip entries of these tenants. */
  excludeTenantIds?: string[]
  /** Skip entries recorded without a tenant. */
  excludeGlobal?: boolean
}

export interface OutboxStore {
  enqueue(entry: { id?: string; event: string; payload: unknown; tenantId?: string; createdAt: number }): Promise<OutboxEntry>
  /** Unpublished entries below the attempt ceiling (minus `filter`'s tenants), oldest first. */
  pending(limit: number, maxAttempts: number, filter?: OutboxPendingFilter): Promise<OutboxEntry[]>
  markPublished(id: string, at: number): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  all(): Promise<OutboxEntry[]>
}

export interface MemoryOutboxStoreOptions {
  /**
   * Published entries kept for inspection (`all()`); older published entries are
   * pruned so a long-running process does not grow without bound. Default 1000.
   * Unpublished and dead entries are never pruned.
   */
  retainPublished?: number
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>()
  private readonly retainPublished: number
  /** Ids of published entries, oldest publication first (for pruning). */
  private readonly published: string[] = []

  constructor(options: MemoryOutboxStoreOptions = {}) {
    this.retainPublished = Math.max(0, options.retainPublished ?? 1000)
  }

  async enqueue(input: { id?: string; event: string; payload: unknown; tenantId?: string; createdAt: number }): Promise<OutboxEntry> {
    const id = input.id ?? randomUUID()
    const entry: OutboxEntry = {
      id,
      event: input.event,
      payload: input.payload,
      createdAt: input.createdAt,
      attempts: 0,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    }
    this.entries.set(id, entry)
    return entry
  }

  async pending(limit: number, maxAttempts: number, filter: OutboxPendingFilter = {}): Promise<OutboxEntry[]> {
    const excluded = new Set(filter.excludeTenantIds ?? [])
    return [...this.entries.values()]
      .filter((entry) => entry.publishedAt === undefined && entry.attempts < maxAttempts)
      .filter((entry) =>
        entry.tenantId === undefined ? !filter.excludeGlobal : !excluded.has(entry.tenantId),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
  }

  async markPublished(id: string, at: number): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.publishedAt !== undefined) return
    entry.publishedAt = at
    this.published.push(id)
    while (this.published.length > this.retainPublished) this.entries.delete(this.published.shift()!)
  }

  async markFailed(id: string, error: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      entry.attempts += 1
      entry.lastError = error
    }
  }

  async all(): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
  }
}

export type OutboxDispatch = (entry: OutboxEntry) => void | Promise<void>

export interface FlushResult {
  published: number
  failed: number
  /**
   * Dispatches still running when `dispatchTimeoutMs` elapsed. The flush stopped
   * waiting for them; their outcome is recorded when they settle and the entry
   * is not re-dispatched meanwhile. Present only when non-zero.
   */
  detached?: number
}

export interface OutboxBackoff {
  /** Base delay before retrying a failed entry. Default 1000 ms. */
  delayMs?: number
  /** 'exponential' doubles the delay per attempt (capped); 'fixed' keeps it constant. Default 'exponential'. */
  type?: 'fixed' | 'exponential'
  /** Ceiling for the exponential delay. Default 60_000 ms. */
  maxDelayMs?: number
}

export interface OutboxOptions {
  /** Attempts before an entry is left as dead (excluded from future flushes). Default 10. */
  maxAttempts?: number
  /**
   * Retry backoff for failed entries. Tracked per relay process (no store/schema
   * change): after a failure the entry is skipped by this process's flushes until
   * its delay elapses. A restart forgets the backoff — worst case one immediate
   * retry, still at-least-once. Pass `false` to retry on every flush (old behavior).
   */
  backoff?: OutboxBackoff | false
  /**
   * Called once when an entry exhausts `maxAttempts` and will no longer be
   * flushed (it stays in the store with its `lastError` for inspection).
   * Default: console.error — dead events should never be silent.
   */
  onDead?: (entry: OutboxEntry, error: unknown) => void
  /**
   * Entries of one batch dispatched in parallel. Default 8, so one slow or
   * hanging downstream (e.g. one tenant's webhook endpoint) cannot serialize the
   * whole batch behind it. Dispatch starts in `createdAt` order; set `1` for
   * strictly sequential delivery.
   */
  concurrency?: number
  /**
   * Most dispatches ONE tenant may have in flight at once — across flushes,
   * counting detached ones (see `dispatchTimeoutMs`). Entries recorded without a
   * tenant share one "global" slot budget. Default `ceil(concurrency / 2)`, so a
   * tenant whose downstream hangs can never hold every worker.
   */
  tenantConcurrency?: number
  /**
   * How long a flush waits on one dispatch before it stops waiting and moves on
   * (default 10_000 ms; `false` waits indefinitely). The dispatch is NOT
   * cancelled or failed: it keeps running "detached", its outcome is recorded
   * when it settles, and the entry is not re-dispatched while it runs — so no
   * duplicate and no lost result. This bounds how long one hanging downstream
   * can hold a flush (and with it every other tenant's next tick).
   */
  dispatchTimeoutMs?: number | false
  now?: () => number
}

/** Tenant key for fairness: the tenant id, or `null` for tenant-less entries. */
type TenantKey = string | null
const tenantKey = (entry: OutboxEntry): TenantKey => entry.tenantId ?? null

/** Extra `pending()` queries a flush may make to look past dominant tenants. */
const MAX_SELECTION_ROUNDS = 8

/**
 * Round-robin across tenants (in order of their oldest entry), keeping each
 * tenant's own entries in `createdAt` order: a tenant with a large backlog gets
 * one slot per round like everyone else instead of the head of the batch.
 */
function interleaveByTenant(entries: OutboxEntry[]): OutboxEntry[] {
  const queues = new Map<TenantKey, OutboxEntry[]>()
  for (const entry of entries) {
    const key = tenantKey(entry)
    const queue = queues.get(key)
    if (queue) queue.push(entry)
    else queues.set(key, [entry])
  }
  const out: OutboxEntry[] = []
  for (let round = 0; out.length < entries.length; round++) {
    for (const queue of queues.values()) if (round < queue.length) out.push(queue[round]!)
  }
  return out
}

export class Outbox {
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly backoff: Required<OutboxBackoff> | false
  private readonly onDead: (entry: OutboxEntry, error: unknown) => void
  private readonly concurrency: number
  private readonly tenantConcurrency: number
  private readonly dispatchTimeoutMs: number | false
  /** entryId → epoch-ms before which this process won't retry it (process-local). */
  private readonly retryAt = new Map<string, number>()
  /** Entries whose dispatch is running (including detached ones), by id. */
  private readonly inFlight = new Set<string>()
  /** Running dispatches per tenant key (including detached ones). */
  private readonly tenantInFlight = new Map<TenantKey, number>()
  /** In-flight flush — concurrent calls coalesce onto it instead of re-reading the batch. */
  private flushing: Promise<FlushResult> | undefined

  constructor(
    private readonly store: OutboxStore,
    options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.now = options.now ?? (() => Date.now())
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 8))
    this.tenantConcurrency = Math.max(1, Math.floor(options.tenantConcurrency ?? Math.ceil(this.concurrency / 2)))
    this.dispatchTimeoutMs =
      options.dispatchTimeoutMs === false ? false : Math.max(1, options.dispatchTimeoutMs ?? 10_000)
    this.backoff =
      options.backoff === false
        ? false
        : {
            delayMs: options.backoff?.delayMs ?? 1000,
            type: options.backoff?.type ?? 'exponential',
            maxDelayMs: options.backoff?.maxDelayMs ?? 60_000,
          }
    this.onDead =
      options.onDead ??
      ((entry, error) =>
        console.error(
          `[basalt:outbox] entry "${entry.event}" (${entry.id}) is dead after ${entry.attempts} attempts:`,
          error,
        ))
  }

  enqueue(event: string, payload: unknown, tenantId?: string): Promise<OutboxEntry> {
    return this.store.enqueue({
      event,
      payload,
      createdAt: this.now(),
      ...(tenantId !== undefined ? { tenantId } : {}),
    })
  }

  /**
   * Delivers up to `batchSize` pending entries with `dispatch`, marking outcomes.
   * Overlap-safe: while a flush is in flight, further calls await and return that
   * flush's result instead of re-selecting (and double-delivering) the same batch.
   */
  flush(dispatch: OutboxDispatch, batchSize = 50): Promise<FlushResult> {
    if (this.flushing) return this.flushing
    this.flushing = this.doFlush(dispatch, batchSize).finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  private async doFlush(dispatch: OutboxDispatch, batchSize: number): Promise<FlushResult> {
    const batch = await this.select(batchSize)
    let published = 0
    let failed = 0
    let detached = 0

    const deliver = async (entry: OutboxEntry): Promise<'published' | 'failed'> => {
      const key = tenantKey(entry)
      this.inFlight.add(entry.id)
      this.tenantInFlight.set(key, (this.tenantInFlight.get(key) ?? 0) + 1)
      try {
        // Isolate each entry from the flush caller's context: a flush started in
        // a tenant's request must not lend that tenant to other tenants' entries
        // (the dispatch scopes itself by `entry.tenantId`, never the ambient one).
        await runWithContext({}, () => dispatch(entry))
        await this.store.markPublished(entry.id, this.now())
        this.retryAt.delete(entry.id)
        return 'published'
      } catch (error) {
        // Read BEFORE markFailed: the memory store mutates the same object.
        const attempts = entry.attempts + 1
        await this.store.markFailed(entry.id, error instanceof Error ? error.message : String(error))
        if (attempts >= this.maxAttempts) {
          this.retryAt.delete(entry.id)
          this.onDead({ ...entry, attempts }, error)
        } else if (this.backoff) {
          this.retryAt.set(entry.id, this.now() + this.retryDelay(attempts))
        }
        return 'failed'
      } finally {
        this.inFlight.delete(entry.id)
        const left = (this.tenantInFlight.get(key) ?? 1) - 1
        if (left > 0) this.tenantInFlight.set(key, left)
        else this.tenantInFlight.delete(key)
      }
    }

    // Waits for one dispatch, but at most `dispatchTimeoutMs`; past that the
    // dispatch runs on detached (still counted in-flight for its tenant).
    const run = async (entry: OutboxEntry): Promise<void> => {
      const outcome = deliver(entry)
      // A store fault while recording a detached outcome has no flush to report
      // to; the entry simply stays pending and is retried (at-least-once).
      outcome.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut =
        this.dispatchTimeoutMs === false
          ? undefined
          : new Promise<'detached'>((resolve) => {
              timer = setTimeout(() => resolve('detached'), this.dispatchTimeoutMs as number)
              ;(timer as { unref?: () => void }).unref?.()
            })
      try {
        const result = await (timedOut ? Promise.race([outcome, timedOut]) : outcome)
        if (result === 'published') published += 1
        else if (result === 'failed') failed += 1
        else detached += 1
      } finally {
        clearTimeout(timer)
      }
    }

    // Bounded parallelism with a per-tenant cap: a worker takes the next entry
    // (tenants interleaved, each FIFO) whose tenant is below its in-flight cap,
    // and exits when only capped tenants remain — their entries stay pending for
    // a later flush instead of holding this one.
    const queue = [...batch]
    const take = (): OutboxEntry | undefined => {
      const index = queue.findIndex((entry) => this.tenantHasCapacity(tenantKey(entry)))
      return index === -1 ? undefined : queue.splice(index, 1)[0]
    }
    const worker = async (): Promise<void> => {
      for (let entry = take(); entry; entry = take()) await run(entry)
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batch.length) }, worker))
    return { published, failed, ...(detached > 0 ? { detached } : {}) }
  }

  private tenantHasCapacity(key: TenantKey): boolean {
    return (this.tenantInFlight.get(key) ?? 0) < this.tenantConcurrency
  }

  /**
   * Picks up to `batchSize` dispatchable entries, fair across tenants.
   *
   * Entries this process is backing off or still dispatching stay "pending" in
   * the store, so each query over-fetches by that many. A tenant whose backlog
   * fills a whole page would otherwise hide every younger tenant behind it
   * (head-of-line): when a page comes back full, the next query excludes the
   * tenants already seen, up to {@link MAX_SELECTION_ROUNDS} times. The result is
   * interleaved round-robin by tenant, so the batch holds every tenant found.
   */
  private async select(batchSize: number): Promise<OutboxEntry[]> {
    const now = this.now()
    for (const [id, at] of this.retryAt) if (at <= now) this.retryAt.delete(id)
    const skipped = (entry: OutboxEntry): boolean =>
      this.inFlight.has(entry.id) || (this.retryAt.get(entry.id) ?? 0) > now
    const overFetch = this.retryAt.size + this.inFlight.size

    // Tenants at their in-flight cap can't be dispatched this flush: don't let
    // their rows take up the page.
    const excluded = new Set<TenantKey>()
    for (const key of this.tenantInFlight.keys()) if (!this.tenantHasCapacity(key)) excluded.add(key)

    const seen = new Set<string>()
    const candidates: OutboxEntry[] = []
    for (let round = 0; round < MAX_SELECTION_ROUNDS; round++) {
      const limit = batchSize + overFetch
      const filter: OutboxPendingFilter = {}
      const ids = [...excluded].filter((key): key is string => key !== null)
      if (ids.length) filter.excludeTenantIds = ids
      if (excluded.has(null)) filter.excludeGlobal = true
      const rows = await this.store.pending(limit, this.maxAttempts, filter)
      let fresh = 0
      for (const entry of rows) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        const key = tenantKey(entry)
        if (excluded.has(key) || skipped(entry)) continue
        candidates.push(entry)
        fresh += 1
      }
      // A short page means nothing else is pending; no new rows means the store
      // ignores the filter — either way another query can't find more.
      if (rows.length < limit || fresh === 0) break
      for (const entry of rows) excluded.add(tenantKey(entry))
    }
    return interleaveByTenant(candidates).slice(0, batchSize)
  }

  private retryDelay(attempts: number): number {
    if (this.backoff === false) return 0
    if (this.backoff.type === 'fixed') return this.backoff.delayMs
    // Clamp the exponent so the delay can't overflow to Infinity.
    return Math.min(this.backoff.delayMs * 2 ** Math.min(attempts - 1, 16), this.backoff.maxDelayMs)
  }
}

export const OUTBOX = createToken<Outbox>('outbox')

export interface OutboxPluginOptions extends OutboxOptions {
  store?: OutboxStore
  /** Delivers a committed entry to the outside world (webhooks, Kafka, …). */
  dispatch: OutboxDispatch
  /** Capture these event patterns into the outbox automatically (needs @basaltkit/events). */
  captureEvents?: string[]
  /** Poll interval in ms to flush the outbox. Omit to flush manually via OUTBOX. */
  intervalMs?: number
  batchSize?: number
  /**
   * A timer/shutdown flush failed at the store level (e.g. `pending()` threw).
   * Per-entry dispatch failures are NOT this — they are marked on the entry.
   * Default: console.error. Must never throw.
   */
  onFlushError?: (error: unknown) => void
}

/**
 * Wires an outbox: resolve `OUTBOX` to enqueue/flush manually, or pass
 * `captureEvents` to record domain events (tenant-scoped) and `intervalMs` to
 * relay them on a timer.
 */
export function outboxPlugin(options: OutboxPluginOptions) {
  const store = options.store ?? new MemoryOutboxStore()
  const outbox = new Outbox(store, options)
  const capture = options.captureEvents ?? []
  let timer: ReturnType<typeof setInterval> | undefined

  return definePlugin({
    name: 'basalt:outbox',
    dependsOn: capture.length ? ['basalt:events'] : [],
    register({ container }) {
      container.singleton(OUTBOX, () => outbox)
    },
    boot({ container }) {
      const onFlushError =
        options.onFlushError ?? ((error: unknown) => console.error('[basalt:outbox] flush failed:', error))
      if (capture.length) {
        const bus = container.get(EVENTS)
        for (const pattern of capture) {
          // AWAITED on purpose: the outbox's whole contract is "nothing is lost
          // after commit". If the capture write fails, the emitter must see it
          // (EventBus aggregates listener failures) rather than silently losing
          // the event while the caller believes it was recorded.
          bus.on(pattern, async (payload, meta) => {
            const tenantId = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
            await outbox.enqueue(meta.name, payload, tenantId)
          })
        }
      }
      if (options.intervalMs) {
        // flush() itself coalesces overlapping ticks; the catch keeps a store
        // fault from becoming an unhandled rejection that kills the process.
        timer = setInterval(
          () => void outbox.flush(options.dispatch, options.batchSize).catch(onFlushError),
          options.intervalMs,
        )
        timer.unref()
      }
    },
    async shutdown() {
      if (timer) clearInterval(timer)
      try {
        await outbox.flush(options.dispatch, options.batchSize) // best-effort final drain
      } catch (error) {
        const onFlushError =
          options.onFlushError ?? ((error_: unknown) => console.error('[basalt:outbox] flush failed:', error_))
        onFlushError(error)
      }
    },
  })
}
