import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@basaltkit/core'
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

export interface OutboxStore {
  enqueue(entry: { id?: string; event: string; payload: unknown; tenantId?: string; createdAt: number }): Promise<OutboxEntry>
  /** Unpublished entries below the attempt ceiling, oldest first. */
  pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]>
  markPublished(id: string, at: number): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  all(): Promise<OutboxEntry[]>
}

export class MemoryOutboxStore implements OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>()

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

  async pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.publishedAt === undefined && entry.attempts < maxAttempts)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
  }

  async markPublished(id: string, at: number): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) entry.publishedAt = at
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
  now?: () => number
}

export class Outbox {
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly backoff: Required<OutboxBackoff> | false
  private readonly onDead: (entry: OutboxEntry, error: unknown) => void
  /** entryId → epoch-ms before which this process won't retry it (process-local). */
  private readonly retryAt = new Map<string, number>()
  /** In-flight flush — concurrent calls coalesce onto it instead of re-reading the batch. */
  private flushing: Promise<FlushResult> | undefined

  constructor(
    private readonly store: OutboxStore,
    options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.now = options.now ?? (() => Date.now())
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
    const now = this.now()
    const pending = (await this.store.pending(batchSize, this.maxAttempts)).filter(
      (entry) => (this.retryAt.get(entry.id) ?? 0) <= now,
    )
    let published = 0
    let failed = 0
    for (const entry of pending) {
      try {
        await dispatch(entry)
        await this.store.markPublished(entry.id, this.now())
        this.retryAt.delete(entry.id)
        published += 1
      } catch (error) {
        // Read BEFORE markFailed: the memory store mutates the same object.
        const attempts = entry.attempts + 1
        await this.store.markFailed(entry.id, error instanceof Error ? error.message : String(error))
        failed += 1
        if (attempts >= this.maxAttempts) {
          this.retryAt.delete(entry.id)
          this.onDead({ ...entry, attempts }, error)
        } else if (this.backoff) {
          this.retryAt.set(entry.id, this.now() + this.retryDelay(attempts))
        }
      }
    }
    return { published, failed }
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
