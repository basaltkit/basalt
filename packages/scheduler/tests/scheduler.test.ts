import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, METADATA } from '@basaltkit/core'
import { defineJob, QueueManager, SyncQueueDriver } from '@basaltkit/queue'
import { SCHEDULER, ScheduleDefinitionError, Scheduler, schedulerPlugin } from '../src/index.js'

const utc = (iso: string) => new Date(iso)

describe('Scheduler', () => {
  it('everyMinute runs on any tick; daily().at only at the given time', async () => {
    const scheduler = new Scheduler()
    const runs: string[] = []
    scheduler.call('minuto', () => void runs.push('minuto'))
    scheduler.call('backup', () => void runs.push('backup')).daily().at('03:00')

    await scheduler.tick(utc('2026-08-05T10:15:00Z'))
    expect(runs).toEqual(['minuto'])
    await scheduler.tick(utc('2026-08-05T03:00:00Z'))
    expect(runs).toEqual(['minuto', 'minuto', 'backup'])
  })

  it('weekly().sundays().at and monthly() respect the calendar', async () => {
    const scheduler = new Scheduler()
    const runs: string[] = []
    scheduler.call('digest', () => void runs.push('digest')).weekly().sundays().at('08:00')
    scheduler.call('fatura', () => void runs.push('fatura')).monthly().at('00:30')

    await scheduler.tick(utc('2026-08-02T08:00:00Z')) // Sunday
    await scheduler.tick(utc('2026-08-03T08:00:00Z')) // Monday
    await scheduler.tick(utc('2026-08-01T00:30:00Z')) // day 1
    await scheduler.tick(utc('2026-08-15T00:30:00Z')) // day 15
    expect(runs).toEqual(['digest', 'fatura'])
  })

  it('custom cron with step and range', async () => {
    const scheduler = new Scheduler()
    let runs = 0
    scheduler.call('sync', () => void runs++).cron('*/15 9-17 * * 1-5')

    await scheduler.tick(utc('2026-08-05T09:30:00Z')) // Wednesday, 09:30 → runs
    await scheduler.tick(utc('2026-08-05T09:31:00Z')) // minute outside the step
    await scheduler.tick(utc('2026-08-05T20:15:00Z')) // outside the hour range
    await scheduler.tick(utc('2026-08-02T09:30:00Z')) // Sunday
    expect(runs).toBe(1)
  })

  it('timezone: daily().at("03:00") in São Paulo = 06:00 UTC', async () => {
    const scheduler = new Scheduler()
    let runs = 0
    scheduler
      .call('relatorio', () => void runs++)
      .daily()
      .at('03:00')
      .timezone('America/Sao_Paulo')

    await scheduler.tick(utc('2026-08-05T03:00:00Z')) // 00:00 in SP → does not run
    expect(runs).toBe(0)
    await scheduler.tick(utc('2026-08-05T06:00:00Z')) // 03:00 in SP → runs
    expect(runs).toBe(1)
  })

  it('withoutOverlapping skips an execution while the previous one is still running', async () => {
    const scheduler = new Scheduler()
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const entry = scheduler
      .call('lento', async () => {
        started++
        await gate
      })
      .everyMinute()
      .withoutOverlapping()

    const first = scheduler.tick(utc('2026-08-05T10:00:00Z'))
    await scheduler.tick(utc('2026-08-05T10:01:00Z')) // previous one still running
    release()
    await first

    expect(started).toBe(1)
    expect(entry.skippedOverlaps).toBe(1)
  })

  it('onFailure captures the error; without onFailure the tick aggregates', async () => {
    const scheduler = new Scheduler()
    const captured: unknown[] = []
    scheduler
      .call('tratado', () => {
        throw new Error('falha tratada')
      })
      .everyMinute()
      .onFailure((error) => void captured.push(error))
    scheduler
      .call('solto', () => {
        throw new Error('falha solta')
      })
      .everyMinute()

    await expect(scheduler.tick(utc('2026-08-05T10:00:00Z'))).rejects.toBeInstanceOf(
      AggregateError,
    )
    expect(captured).toHaveLength(1)
  })

  it('schedules dispatch of @basaltkit/queue jobs', async () => {
    const manager = new QueueManager(new SyncQueueDriver())
    const seen: string[] = []
    const Reconcile = defineJob({
      name: 'billing.reconcile',
      schema: z.object({ mode: z.string() }),
      handle: ({ mode }) => void seen.push(mode),
    })
    manager.register(Reconcile)

    const scheduler = new Scheduler()
    scheduler.job(Reconcile, { mode: 'full' }).daily().at('03:00')

    await scheduler.tick(utc('2026-08-05T03:00:00Z'))
    expect(seen).toEqual(['full'])
    expect(scheduler.list()).toEqual([
      { name: 'billing.reconcile', cron: '0 3 * * *', timezone: 'UTC' },
    ])
  })

  it('schedulerPlugin: define at boot, stop at shutdown', async () => {
    let defined = false
    const app = await createApp({
      plugins: [
        schedulerPlugin({
          autostart: false,
          define: (schedule) => {
            defined = true
            schedule.call('noop', () => {}).hourly()
          },
        }),
      ],
    }).boot()

    expect(defined).toBe(true)
    expect(app.container.get(SCHEDULER).list()).toEqual([
      { name: 'noop', cron: '0 * * * *', timezone: 'UTC' },
    ])
    // entries are published to the metadata registry for the CLI
    expect(app.container.get(METADATA).get('schedule:entries')).toEqual([
      { name: 'noop', cron: '0 * * * *', timezone: 'UTC' },
    ])
    await app.shutdown()
  })
})

describe('multi-replica one-server locking (Q-4)', () => {
  /** Shared "Redis": first acquire of a key wins, per (key, until-expiry). */
  const sharedLock = () => {
    const held = new Map<string, number>()
    return {
      calls: [] as string[],
      async acquire(key: string, ttlMs: number): Promise<boolean> {
        this.calls.push(key)
        const now = Date.now()
        const until = held.get(key)
        if (until !== undefined && until > now) return false
        held.set(key, now + ttlMs)
        return true
      },
    }
  }

  it('runs a .onOneServer() entry on exactly one of N replicas per tick', async () => {
    const lock = sharedLock()
    const runs: string[] = []
    const replicas = [1, 2, 3].map((n) => {
      const scheduler = new Scheduler({ lock })
      scheduler.call('reconcile-billing', () => void runs.push(`replica-${n}`)).everyMinute().onOneServer()
      return scheduler
    })
    const instant = new Date('2026-08-29T03:00:00Z')
    await Promise.all(replicas.map((s) => s.tick(instant)))
    expect(runs).toHaveLength(1) // not 3
    expect(lock.calls[0]).toContain('reconcile-billing')
  })

  it('a fast first run does not let a second replica re-acquire within the same tick window', async () => {
    const lock = sharedLock()
    const runs: number[] = []
    const a = new Scheduler({ lock })
    a.call('job', () => void runs.push(1)).everyMinute().onOneServer()
    const b = new Scheduler({ lock })
    b.call('job', () => void runs.push(2)).everyMinute().onOneServer()
    const instant = new Date('2026-08-29T03:00:00Z')
    await a.tick(instant) // finishes instantly
    await b.tick(instant) // late replica, same minute
    expect(runs).toEqual([1]) // the lock is held for the window, not released on completion
  })

  it('entries without onOneServer() are unaffected by the lock', async () => {
    const lock = sharedLock()
    const runs: number[] = []
    const scheduler = new Scheduler({ lock })
    scheduler.call('local', () => void runs.push(1)).everyMinute()
    await scheduler.tick(new Date('2026-08-29T03:00:00Z'))
    expect(runs).toEqual([1])
    expect(lock.calls).toEqual([]) // no lock traffic
  })

  it('schedulerPlugin fails loud at boot when onOneServer() is used without a lock', async () => {
    await expect(
      createApp({
        plugins: [
          schedulerPlugin({
            autostart: false,
            define: (schedule) => void schedule.call('x', () => {}).everyMinute().onOneServer(),
          }),
        ],
      }).boot(),
    ).rejects.toThrow(/onOneServer|lock/i)
  })
})

describe('cron field validation (Q-8 pin)', () => {
  it('rejects unsupported/typo fields instead of silently never firing', async () => {
    const { parseCron, CronParseError } = await import('../src/cron.js')
    for (const bad of ['a b c d e', 'MON * * * *', '61 * * * *', '*/0 * * * *', '5-1 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7']) {
      expect(() => parseCron(bad), bad).toThrow(CronParseError)
    }
  })

  it('accepts the full supported syntax', async () => {
    const { parseCron } = await import('../src/cron.js')
    for (const good of ['* * * * *', '*/15 0 1,15 * 1-5', '0 3 * * 0', '59 23 31 12 6']) {
      expect(() => parseCron(good), good).not.toThrow()
    }
  })
})

describe('one frequency per entry (definition-time guard)', () => {
  const definitionError = (define: (scheduler: Scheduler) => unknown): ScheduleDefinitionError => {
    try {
      define(new Scheduler())
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleDefinitionError)
      return error as ScheduleDefinitionError
    }
    throw new Error('expected a ScheduleDefinitionError')
  }

  it('.daily().monthly() throws SCHEDULE_CONFLICT naming the entry and both calls', () => {
    const error = definitionError((s) => s.call('backup', () => {}).daily().monthly())
    expect(error.code).toBe('SCHEDULE_CONFLICT')
    expect(error.message).toContain('Schedule "backup"')
    expect(error.message).toContain('.monthly() conflicts with .daily()')
    expect(error.message).toContain(".monthly().at('HH:mm')")
  })

  it('.daily().everyMinute() throws SCHEDULE_CONFLICT', () => {
    const error = definitionError((s) => s.call('dump', () => {}).daily().everyMinute())
    expect(error.code).toBe('SCHEDULE_CONFLICT')
    expect(error.message).toContain('Schedule "dump"')
    expect(error.message).toContain('.everyMinute() conflicts with .daily()')
  })

  it('.cron(...).daily() throws SCHEDULE_CONFLICT', () => {
    const error = definitionError((s) => s.call('sync', () => {}).cron('*/5 * * * *').daily())
    expect(error.code).toBe('SCHEDULE_CONFLICT')
    expect(error.message).toContain(".daily() conflicts with .cron('*/5 * * * *')")
  })

  it('.hourly().at() and .at() twice throw SCHEDULE_CONFLICT', () => {
    const afterHourly = definitionError((s) => s.call('x', () => {}).hourly().at('03:00'))
    expect(afterHourly.code).toBe('SCHEDULE_CONFLICT')
    expect(afterHourly.message).toContain(".at('03:00') conflicts with .hourly()")

    const twice = definitionError((s) => s.call('x', () => {}).daily().at('03:00').at('04:00'))
    expect(twice.code).toBe('SCHEDULE_CONFLICT')
    expect(twice.message).toContain(".at('04:00') conflicts with .at('03:00')")
  })

  it('.at() after everyMinute/everyMinutes/cron, and a non-time frequency after .at(), throw', () => {
    for (const define of [
      (s: Scheduler) => s.call('x', () => {}).everyMinute().at('03:00'),
      (s: Scheduler) => s.call('x', () => {}).everyMinutes(5).at('03:00'),
      (s: Scheduler) => s.call('x', () => {}).cron('0 3 * * *').at('03:00'),
      (s: Scheduler) => s.call('x', () => {}).at('03:00').hourly(),
    ]) {
      expect(definitionError(define).code).toBe('SCHEDULE_CONFLICT')
    }
  })

  it('day-of-week modifiers conflict with .cron() in either order', () => {
    const after = definitionError((s) => s.call('x', () => {}).cron('0 3 * * *').mondays())
    expect(after.code).toBe('SCHEDULE_CONFLICT')
    expect(after.message).toContain(".mondays() conflicts with .cron('0 3 * * *')")
    expect(definitionError((s) => s.call('x', () => {}).fridays().cron('0 3 * * *')).code).toBe(
      'SCHEDULE_CONFLICT',
    )
  })

  it('.at() rejects malformed times with SCHEDULE_INVALID_TIME', () => {
    for (const bad of ['25:00', 'ab', '03:60', '3', '03:5', '']) {
      const error = definitionError((s) => s.call('x', () => {}).at(bad))
      expect(error.code, bad).toBe('SCHEDULE_INVALID_TIME')
    }
  })

  it('valid combinations still build the right cron', () => {
    const scheduler = new Scheduler()
    expect(scheduler.call('a', () => {}).monthly().at('03:00').describe().cron).toBe('0 3 1 * *')
    expect(scheduler.call('b', () => {}).weekly().mondays().at('07:30').describe().cron).toBe('30 7 * * 1')
    const entry = scheduler
      .call('c', () => {})
      .daily()
      .at('03:00')
      .timezone('Africa/Luanda')
      .withoutOverlapping()
      .onOneServer()
    expect(entry.describe()).toEqual({ name: 'c', cron: '0 3 * * *', timezone: 'Africa/Luanda' })
    expect(scheduler.call('d', () => {}).at('9:05').describe().cron).toBe('5 9 * * *')
    expect(scheduler.call('e', () => {}).at('03:00').daily().describe().cron).toBe('0 3 * * *')
    expect(scheduler.call('f', () => {}).hourly().fridays().describe().cron).toBe('0 * * * 5')
  })

  it('frequencies do not chain internally (weekly() alone does not trip the guard)', () => {
    const scheduler = new Scheduler()
    expect(scheduler.call('w', () => {}).weekly().describe().cron).toBe('0 0 * * 0')
    expect(scheduler.call('m', () => {}).monthly().describe().cron).toBe('0 0 1 * *')
    expect(scheduler.call('h', () => {}).hourly().describe().cron).toBe('0 * * * *')
    expect(scheduler.call('n', () => {}).everyMinutes(15).describe().cron).toBe('*/15 * * * *')
  })

  it('a conflicting entry fails the app at boot', async () => {
    await expect(
      createApp({
        plugins: [
          schedulerPlugin({
            autostart: false,
            define: (schedule) => void schedule.call('backup', () => {}).daily().monthly(),
          }),
        ],
      }).boot(),
    ).rejects.toThrow(ScheduleDefinitionError)
  })
})
