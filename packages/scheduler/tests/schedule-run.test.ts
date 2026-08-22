import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata } from '@basaltkit/core'
import { Scheduler, schedulerPlugin } from '../src/index.js'

describe('Scheduler.runNow', () => {
  it('runs a named entry on demand, ignoring its cron', async () => {
    const scheduler = new Scheduler()
    const runs: string[] = []
    scheduler.call('backup', () => void runs.push('backup')).daily().at('03:00')
    // never due at 10:15, but runNow ignores the cron
    expect(await scheduler.runNow('backup')).toBe(true)
    expect(runs).toEqual(['backup'])
  })

  it('returns false for an unknown entry', async () => {
    expect(await new Scheduler().runNow('nope')).toBe(false)
  })

  it('names() lists every entry', () => {
    const s = new Scheduler()
    s.call('a', () => {})
    s.call('b', () => {})
    expect(s.names()).toEqual(['a', 'b'])
  })
})

const fakeIo = () => {
  const logs: string[] = []
  const errors: string[] = []
  return { logs, errors, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }
}

async function bootWithCommand(define: (s: Scheduler) => void) {
  const app = await createApp({ plugins: [schedulerPlugin({ define, autostart: false })] }).boot()
  const commands = ensureMetadata(app.container).get<{
    name: string
    handle: (ctx: unknown) => Promise<number | void>
  }>('commands')
  return { app, cmd: commands.find((c) => c.name === 'schedule:run')! }
}

describe('schedule:run command', () => {
  it('is registered by the scheduler plugin', async () => {
    const { cmd } = await bootWithCommand(() => {})
    expect(cmd).toBeTruthy()
  })

  it('runs a named task on demand', async () => {
    const runs: string[] = []
    const { cmd } = await bootWithCommand((s) => s.call('report', () => void runs.push('report')).daily().at('02:00'))
    const io = fakeIo()
    await cmd.handle({ io, args: ['report'], flags: {} })
    expect(runs).toEqual(['report'])
    expect(io.logs[0]).toContain('Ran scheduled task "report"')
  })

  it('--due runs all currently-due tasks', async () => {
    const runs: string[] = []
    const { cmd } = await bootWithCommand((s) => s.call('tick-task', () => void runs.push('due')).everyMinute())
    const io = fakeIo()
    await cmd.handle({ io, args: [], flags: { due: true } })
    expect(runs).toEqual(['due'])
    expect(io.logs[0]).toContain('Ran all due')
  })

  it('errors on an unknown task name, listing what is available', async () => {
    const { cmd } = await bootWithCommand((s) => s.call('known', () => {}))
    const io = fakeIo()
    const code = await cmd.handle({ io, args: ['ghost'], flags: {} })
    expect(code).toBe(1)
    expect(io.errors[0]).toMatch(/Unknown scheduled task "ghost".*known/)
  })

  it('errors with usage when no name and no --due', async () => {
    const { cmd } = await bootWithCommand(() => {})
    const io = fakeIo()
    expect(await cmd.handle({ io, args: [], flags: {} })).toBe(1)
    expect(io.errors[0]).toMatch(/Usage: basalt schedule:run/)
  })
})
