import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, HookBus } from '@basaltkit/core'
import {
  defineReconciler,
  ScheduleDefinitionError,
  Scheduler,
  SCHEDULER,
  schedulerPlugin,
  type ReconcilerLock,
  type ReconcilerRunResult,
  type ScheduleLock,
} from '../src/index.js'

interface Stuck {
  id: string
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('defineReconciler — run()', () => {
  it('redispatches every stuck item and reports counts', async () => {
    const seen: string[] = []
    const reconciler = defineReconciler<Stuck>({
      name: 'stuck-orders',
      every: '5m',
      find: async () => [{ id: 'a' }, { id: 'b' }],
      redispatch: async (item) => void seen.push(item.id),
    })
    const result = await reconciler.run()
    expect(seen).toEqual(['a', 'b'])
    expect(result).toMatchObject({ name: 'stuck-orders', found: 2, redispatched: 2, failed: 0, skipped: false })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('isolates per-item failures: one bad item does not stop the others', async () => {
    const seen: string[] = []
    const errors: [unknown, Stuck | undefined][] = []
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      find: () => [{ id: 'a' }, { id: 'boom' }, { id: 'c' }],
      redispatch: (item) => {
        if (item.id === 'boom') throw new Error('queue down')
        seen.push(item.id)
      },
      onError: (error, item) => void errors.push([error, item]),
    })
    const result = await reconciler.run()
    expect(seen).toEqual(['a', 'c'])
    expect(result).toMatchObject({ found: 3, redispatched: 2, failed: 1 })
    expect(errors).toHaveLength(1)
    expect((errors[0]![0] as Error).message).toBe('queue down')
    expect(errors[0]![1]).toEqual({ id: 'boom' })
  })

  it('caps the work of one run at maxPerRun', async () => {
    const seen: string[] = []
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      maxPerRun: 2,
      find: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      redispatch: (item) => void seen.push(item.id),
    })
    const result = await reconciler.run()
    expect(seen).toEqual(['a', 'b'])
    expect(result).toMatchObject({ found: 3, redispatched: 2, failed: 0 })
  })

  it('a failing find() is reported through onError (item undefined), not thrown', async () => {
    const errors: unknown[] = []
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      find: () => Promise.reject(new Error('db down')),
      redispatch: () => {},
      onError: (error, item) => void errors.push([(error as Error).message, item]),
    })
    const result = await reconciler.run()
    expect(errors).toEqual([['db down', undefined]])
    expect(result).toMatchObject({ found: 0, redispatched: 0, failed: 0 })
    expect((result.error as Error).message).toBe('db down')
  })

  it('defaults onError to console.error (never silent)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = defineReconciler<Stuck>({
      name: 'loud',
      every: '1m',
      find: () => [{ id: 'x' }],
      redispatch: () => {
        throw new Error('nope')
      },
    })
    await reconciler.run()
    expect(spy).toHaveBeenCalled()
    expect(String(spy.mock.calls[0]![0])).toContain('loud')
    spy.mockRestore()
  })

  it('never starts a run while the previous one is still running (in-process overlap guard)', async () => {
    const gate = deferred()
    let finds = 0
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      find: async () => {
        finds++
        return [{ id: 'a' }]
      },
      redispatch: () => gate.promise,
    })
    const first = reconciler.run()
    const second = await reconciler.run()
    expect(second).toMatchObject({ skipped: true, reason: 'overlap', found: 0 })
    gate.resolve()
    expect(await first).toMatchObject({ skipped: false, redispatched: 1 })
    expect(finds).toBe(1)
    expect(reconciler.stats).toMatchObject({ runs: 1, skippedOverlaps: 1, redispatched: 1, failed: 0 })
  })

  it('holds a distributed lock for the whole run and releases it', async () => {
    const held = new Set<string>()
    const calls: string[] = []
    const lock: ReconcilerLock = {
      async acquire(key, ttlMs) {
        calls.push(`acquire:${key}:${ttlMs}`)
        if (held.has(key)) return false
        held.add(key)
        return true
      },
      async release(key) {
        calls.push(`release:${key}`)
        held.delete(key)
      },
    }
    const gate = deferred()
    const make = () =>
      defineReconciler<Stuck>({
        name: 'orders',
        every: '1m',
        lock,
        lockTtlMs: 30_000,
        find: () => [{ id: 'a' }],
        redispatch: () => gate.promise,
      })
    // Two replicas, each with its own reconciler instance.
    const replicaA = make()
    const replicaB = make()
    const runA = replicaA.run()
    await Promise.resolve()
    await Promise.resolve()
    const runB = await replicaB.run()
    expect(runB).toMatchObject({ skipped: true, reason: 'locked' })
    gate.resolve()
    expect(await runA).toMatchObject({ skipped: false, redispatched: 1 })
    expect(calls).toContain('acquire:basalt:reconciler:orders:30000')
    expect(calls.at(-1)).toBe('release:basalt:reconciler:orders')
    expect(held.size).toBe(0)
  })

  it('emits reconciler:run on the hook bus with the counts', async () => {
    const hooks = new HookBus()
    const events: ReconcilerRunResult[] = []
    hooks.on('reconciler:run', (payload) => void events.push(payload))
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      hooks,
      find: () => [{ id: 'a' }],
      redispatch: () => {},
    })
    await reconciler.run()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'r', found: 1, redispatched: 1, failed: 0, skipped: false })
  })

  it('a throwing hook handler does not break the run', async () => {
    const hooks = new HookBus()
    hooks.on('reconciler:run', () => {
      throw new Error('observer broke')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reconciler = defineReconciler<Stuck>({
      name: 'r',
      every: '1m',
      hooks,
      find: () => [{ id: 'a' }],
      redispatch: () => {},
    })
    await expect(reconciler.run()).resolves.toMatchObject({ redispatched: 1 })
    spy.mockRestore()
  })
})

describe('defineReconciler — cadence', () => {
  const cronOf = (every: string | number) => {
    const scheduler = new Scheduler()
    defineReconciler({ name: 'r', every, find: () => [], redispatch: () => {} }).schedule(scheduler)
    return scheduler.list()[0]!.cron
  }

  it('maps durations and raw cron expressions to the schedule', () => {
    expect(cronOf('1m')).toBe('* * * * *')
    expect(cronOf('5m')).toBe('*/5 * * * *')
    expect(cronOf(15 * 60_000)).toBe('*/15 * * * *')
    expect(cronOf('2h')).toBe('0 */2 * * *')
    expect(cronOf('1d')).toBe('0 0 * * *')
    expect(cronOf('*/10 * * * *')).toBe('*/10 * * * *')
  })

  it('rejects cadences the minute-based scheduler cannot express', () => {
    expect(() => cronOf('30s')).toThrow(ScheduleDefinitionError)
    expect(() => cronOf('90m')).toThrow(ScheduleDefinitionError)
    expect(() => cronOf('7m')).toThrow(ScheduleDefinitionError)
  })
})

describe('defineReconciler — on the scheduler (fake timers)', () => {
  it('runs on its cadence and skips ticks while a slow run is in flight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T10:00:30Z'))
    const scheduler = new Scheduler()
    let gate = deferred()
    let finds = 0
    const reconciler = defineReconciler<Stuck>({
      name: 'stuck',
      every: '1m',
      find: async () => {
        finds++
        return [{ id: `x${finds}` }]
      },
      redispatch: () => gate.promise,
    })
    reconciler.schedule(scheduler)
    scheduler.start()

    await vi.advanceTimersByTimeAsync(30_000) // 10:01:00 → first run starts, hangs
    expect(finds).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000) // 10:02:00 → still running → skipped
    await vi.advanceTimersByTimeAsync(60_000) // 10:03:00 → skipped
    expect(finds).toBe(1)
    expect(reconciler.stats.skippedOverlaps).toBe(2)

    gate.resolve()
    gate = deferred()
    gate.resolve()
    await vi.advanceTimersByTimeAsync(60_000) // 10:04:00 → free again
    expect(finds).toBe(2)
    expect(reconciler.stats).toMatchObject({ runs: 2, redispatched: 2 })
    scheduler.stop()
  })

  it('schedulerPlugin wires the app hook bus and .onOneServer() when a lock exists', async () => {
    const acquired: string[] = []
    const lock: ScheduleLock = {
      async acquire(key) {
        acquired.push(key)
        return true
      },
    }
    const events: ReconcilerRunResult[] = []
    const app = createApp({
      plugins: [
        schedulerPlugin({
          autostart: false,
          lock,
          define: (schedule) =>
            defineReconciler<Stuck>({
              name: 'stuck',
              every: '1m',
              find: () => [{ id: 'a' }],
              redispatch: () => {},
            }).schedule(schedule),
        }),
      ],
    })
    app.hooks.on('reconciler:run', (payload) => void events.push(payload))
    await app.boot()
    await app.container.get(SCHEDULER).tick(new Date('2026-09-19T10:00:00Z'))
    expect(acquired).toEqual(['basalt:schedule:reconciler:stuck:2026-09-19T10:00:00.000Z'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ name: 'stuck', redispatched: 1 })
    await app.shutdown()
  })
})
