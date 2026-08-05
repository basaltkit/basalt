import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, METADATA } from '@machize/core'
import { defineJob, QueueManager, SyncQueueDriver } from '@machize/queue'
import { SCHEDULER, Scheduler, schedulerPlugin } from '../src/index.js'

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

  it('schedules dispatch of @machize/queue jobs', async () => {
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
