import { parseDuration, type DurationInput, type HookBus } from '@basaltkit/core'
import type { ScheduleEntry, Scheduler, ScheduleLock } from './index.js'
import { ScheduleDefinitionError } from './index.js'

/**
 * A stuck-work reconciler: periodically finds business entities left in an
 * intermediate state (the dispatch after the commit failed, a worker died
 * mid-job, …) and re-dispatches them.
 *
 *     defineReconciler({
 *       name: 'stuck-orders',
 *       every: '5m',
 *       find: () => db.order.findMany({ where: { status: 'processing', updatedAt: { lt: minutesAgo(15) } } }),
 *       redispatch: (order) => ProcessOrder.dispatch({ orderId: order.id }),
 *     }).schedule(scheduler)
 *
 * `redispatch` must be idempotent: a reconciler is an at-least-once safety net,
 * and the "stuck" item may simply be slow.
 */

declare module '@basaltkit/core' {
  interface BasaltHooks {
    /** One reconciler run finished (or was skipped). */
    'reconciler:run': ReconcilerRunResult
  }
}

/**
 * Cross-replica mutex held for a WHOLE reconciler run (unlike {@link ScheduleLock},
 * which only covers one tick). `acquire` must be atomic across processes and the
 * key must expire after `ttlMs` so a crashed holder can't block the reconciler
 * forever (e.g. Redis `SET key v PX ttl NX` + `DEL key`).
 */
export interface ReconcilerLock {
  acquire(key: string, ttlMs: number): Promise<boolean>
  release(key: string): Promise<void>
}

export interface ReconcilerOptions<T> {
  /** Unique name — used in the schedule entry (`reconciler:<name>`), lock key, hook payload and logs. */
  name: string
  /**
   * Cadence: a duration the minute-based scheduler can express — whole minutes
   * dividing 60 (`'1m'`, `'5m'`, `'15m'`), whole hours dividing 24 (`'2h'`) or
   * `'1d'` — or a raw 5-field cron expression (`'*\/10 * * * *'`).
   */
  every: DurationInput
  /** Returns the stuck items. Keep it bounded (a `take`) — `maxPerRun` only caps the work, not the query. */
  find: () => T[] | Promise<T[]>
  /** Re-dispatches one item. Must be idempotent. A throw is isolated to that item. */
  redispatch: (item: T) => void | Promise<void>
  /** Most items re-dispatched per run; the rest wait for the next run. Default 100. */
  maxPerRun?: number
  /**
   * An item's `redispatch` threw (`item` set) or `find` threw (`item` undefined).
   * Default: `console.error` — a stuck item that can't be recovered must never be
   * silent. Must not throw.
   */
  onError?: (error: unknown, item: T | undefined) => void
  /** Called after every run (also skipped ones) with its counts — for metrics. */
  onRun?: (result: ReconcilerRunResult) => void
  /**
   * Hook bus on which `reconciler:run` is emitted. Default: the app's bus when
   * scheduled on the `schedulerPlugin`'s scheduler.
   */
  hooks?: HookBus
  /**
   * Distributed mutex held for the whole run, so two replicas never reconcile at
   * the same time even when a run outlasts the cadence. Optional: without it the
   * in-process guard still applies, and a scheduler with a `lock` already runs the
   * entry on one replica per tick (`.onOneServer()`).
   */
  lock?: ReconcilerLock
  /** TTL of the run lock (lease) — must exceed the longest run. Default 15 minutes. */
  lockTtlMs?: number
  /** Timezone for cron cadences. Default 'UTC'. */
  timezone?: string
  /**
   * Run on one replica per tick when the scheduler has a `lock`. Default true;
   * ignored when the scheduler has no lock (in-process guard only).
   */
  onOneServer?: boolean
}

export interface ReconcilerRunResult {
  name: string
  /** Items returned by `find`. */
  found: number
  /** Items re-dispatched successfully. */
  redispatched: number
  /** Items whose `redispatch` threw. */
  failed: number
  /** The run did not happen: the previous one is still running, or another replica holds the lock. */
  skipped: boolean
  reason?: 'overlap' | 'locked'
  /** `find` (or the lock) failed — the run reconciled nothing. */
  error?: unknown
  durationMs: number
}

export interface ReconcilerStats {
  runs: number
  skippedOverlaps: number
  skippedLocked: number
  found: number
  redispatched: number
  failed: number
}

export interface Reconciler {
  readonly name: string
  /** Cumulative counters since the process started. */
  readonly stats: Readonly<ReconcilerStats>
  /** Runs one reconciliation now (overlap guard and lock apply). Never throws. */
  run(): Promise<ReconcilerRunResult>
  /** Adds the reconciler to a scheduler on its cadence; returns the entry. */
  schedule(scheduler: Scheduler): ScheduleEntry
}

/** Converts `every` into a cron expression the minute-based scheduler understands. */
function everyToCron(name: string, every: DurationInput): string {
  if (typeof every === 'string' && every.trim().split(/\s+/).length === 5) return every.trim()
  const ms = parseDuration(every)
  const invalid = (): never => {
    throw new ScheduleDefinitionError(
      'SCHEDULE_INVALID_INTERVAL',
      `Reconciler "${name}": every=${JSON.stringify(every)} can't be scheduled on a minute-based cron. ` +
        `Use whole minutes dividing 60 ('1m', '5m', '15m'), whole hours dividing 24 ('2h'), '1d', or a cron expression.`,
    )
  }
  if (ms % 60_000 !== 0 || ms === 0) return invalid()
  const minutes = ms / 60_000
  if (minutes === 1) return '* * * * *'
  if (minutes < 60) return 60 % minutes === 0 ? `*/${minutes} * * * *` : invalid()
  if (minutes % 60 !== 0) return invalid()
  const hours = minutes / 60
  if (hours === 1) return '0 * * * *'
  if (hours < 24) return 24 % hours === 0 ? `0 */${hours} * * *` : invalid()
  return hours === 24 ? '0 0 * * *' : invalid()
}

export function defineReconciler<T>(options: ReconcilerOptions<T>): Reconciler {
  const cron = everyToCron(options.name, options.every) // fail at definition, i.e. at boot
  const maxPerRun = Math.max(1, Math.floor(options.maxPerRun ?? 100))
  const lockKey = `basalt:reconciler:${options.name}`
  const lockTtlMs = options.lockTtlMs ?? 15 * 60_000
  const onError =
    options.onError ??
    ((error: unknown, item: T | undefined) =>
      console.error(
        item === undefined
          ? `[basalt:reconciler] "${options.name}" find() failed:`
          : `[basalt:reconciler] "${options.name}" redispatch failed:`,
        error,
        ...(item === undefined ? [] : [item]),
      ))
  const stats: ReconcilerStats = { runs: 0, skippedOverlaps: 0, skippedLocked: 0, found: 0, redispatched: 0, failed: 0 }
  let hooks = options.hooks
  let running = false

  const report = async (result: ReconcilerRunResult): Promise<ReconcilerRunResult> => {
    try {
      options.onRun?.(result)
    } catch (error) {
      console.error(`[basalt:reconciler] "${options.name}" onRun threw:`, error)
    }
    if (hooks) {
      try {
        await hooks.emit('reconciler:run', result)
      } catch (error) {
        // An observer must never turn a completed reconciliation into a failure.
        console.error(`[basalt:reconciler] "${options.name}" reconciler:run hook failed:`, error)
      }
    }
    return result
  }

  const safeOnError = (error: unknown, item: T | undefined): void => {
    try {
      onError(error, item)
    } catch {
      // onError must not throw; a broken handler can't stop the other items
    }
  }

  const run = async (): Promise<ReconcilerRunResult> => {
    const started = Date.now()
    const base = { name: options.name, found: 0, redispatched: 0, failed: 0 }
    if (running) {
      stats.skippedOverlaps++
      return report({ ...base, skipped: true, reason: 'overlap', durationMs: 0 })
    }
    running = true
    let locked = false
    try {
      if (options.lock) {
        try {
          locked = await options.lock.acquire(lockKey, lockTtlMs)
        } catch (error) {
          // A lock-store fault is not permission to run on every replica at once.
          safeOnError(error, undefined)
          return report({ ...base, skipped: true, reason: 'locked', error, durationMs: Date.now() - started })
        }
        if (!locked) {
          stats.skippedLocked++
          return report({ ...base, skipped: true, reason: 'locked', durationMs: Date.now() - started })
        }
      }
      stats.runs++
      let items: T[]
      try {
        items = await options.find()
      } catch (error) {
        safeOnError(error, undefined)
        return report({ ...base, skipped: false, error, durationMs: Date.now() - started })
      }
      const result = { ...base, found: items.length }
      for (const item of items.slice(0, maxPerRun)) {
        try {
          await options.redispatch(item)
          result.redispatched++
        } catch (error) {
          result.failed++
          safeOnError(error, item)
        }
      }
      stats.found += result.found
      stats.redispatched += result.redispatched
      stats.failed += result.failed
      return report({ ...result, skipped: false, durationMs: Date.now() - started })
    } finally {
      if (locked) {
        try {
          await options.lock!.release(lockKey)
        } catch (error) {
          // The TTL frees it anyway; report so a broken lock store is visible.
          safeOnError(error, undefined)
        }
      }
      running = false
    }
  }

  return {
    name: options.name,
    stats,
    run,
    schedule(scheduler: Scheduler): ScheduleEntry {
      hooks ??= scheduler.hooks
      const entry = scheduler
        .call(`reconciler:${options.name}`, async () => {
          await run()
        })
        .cron(cron)
        .timezone(options.timezone ?? 'UTC')
      if (scheduler.hasLock && options.onOneServer !== false) entry.onOneServer()
      return entry
    },
  }
}
