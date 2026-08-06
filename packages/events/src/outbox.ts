import { randomUUID } from 'node:crypto'
import { createToken, definePlugin, tryCtx } from '@machize/core'
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

export interface OutboxOptions {
  /** Attempts before an entry is left as dead (excluded from future flushes). Default 10. */
  maxAttempts?: number
  now?: () => number
}

export class Outbox {
  private readonly maxAttempts: number
  private readonly now: () => number

  constructor(
    private readonly store: OutboxStore,
    options: OutboxOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.now = options.now ?? (() => Date.now())
  }

  enqueue(event: string, payload: unknown, tenantId?: string): Promise<OutboxEntry> {
    return this.store.enqueue({
      event,
      payload,
      createdAt: this.now(),
      ...(tenantId !== undefined ? { tenantId } : {}),
    })
  }

  /** Delivers up to `batchSize` pending entries with `dispatch`, marking outcomes. */
  async flush(dispatch: OutboxDispatch, batchSize = 50): Promise<FlushResult> {
    const pending = await this.store.pending(batchSize, this.maxAttempts)
    let published = 0
    let failed = 0
    for (const entry of pending) {
      try {
        await dispatch(entry)
        await this.store.markPublished(entry.id, this.now())
        published += 1
      } catch (error) {
        await this.store.markFailed(entry.id, error instanceof Error ? error.message : String(error))
        failed += 1
      }
    }
    return { published, failed }
  }
}

export const OUTBOX = createToken<Outbox>('outbox')

export interface OutboxPluginOptions extends OutboxOptions {
  store?: OutboxStore
  /** Delivers a committed entry to the outside world (webhooks, Kafka, …). */
  dispatch: OutboxDispatch
  /** Capture these event patterns into the outbox automatically (needs @machize/events). */
  captureEvents?: string[]
  /** Poll interval in ms to flush the outbox. Omit to flush manually via OUTBOX. */
  intervalMs?: number
  batchSize?: number
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
    name: 'machize:outbox',
    dependsOn: capture.length ? ['machize:events'] : [],
    register({ container }) {
      container.singleton(OUTBOX, () => outbox)
    },
    boot({ container }) {
      if (capture.length) {
        const bus = container.get(EVENTS)
        for (const pattern of capture) {
          bus.on(pattern, (payload, meta) => {
            const tenantId = (tryCtx() as { tenant?: { id?: string } } | undefined)?.tenant?.id
            void outbox.enqueue(meta.name, payload, tenantId)
          })
        }
      }
      if (options.intervalMs) {
        timer = setInterval(() => void outbox.flush(options.dispatch, options.batchSize), options.intervalMs)
        timer.unref()
      }
    },
    async shutdown() {
      if (timer) clearInterval(timer)
      await outbox.flush(options.dispatch, options.batchSize) // best-effort final drain
    },
  })
}
