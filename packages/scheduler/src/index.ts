import { createToken, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import type { JobDefinition } from '@basaltkit/queue'
import { cronMatches, cronToString, parseCron, type CronFields } from './cron.js'

export { CronParseError, cronMatches, parseCron, fieldMatches, zonedParts } from './cron.js'
export type { CronFields, ZonedParts } from './cron.js'

type Task = () => void | Promise<void>

/**
 * A scheduled entry, built fluently:
 *
 * schedule.job(ReconcileBilling).daily().at('03:00').timezone('UTC')
 * schedule.call('purge-cache', () => cache.flush()).everyMinute().withoutOverlapping()
 */
export class ScheduleEntry {
  private fields: CronFields = {
    minute: '*',
    hour: '*',
    dayOfMonth: '*',
    month: '*',
    dayOfWeek: '*',
  }
  private tz = 'UTC'
  private noOverlap = false
  private failureHandler: ((error: unknown) => void) | undefined
  private running = false
  /** count of executions skipped due to overlap — visible for observability/tests */
  skippedOverlaps = 0

  constructor(
    readonly name: string,
    private readonly task: Task,
  ) {}

  everyMinute(): this {
    this.fields = { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' }
    return this
  }

  everyMinutes(n: number): this {
    this.everyMinute()
    this.fields.minute = `*/${n}`
    return this
  }

  hourly(): this {
    this.everyMinute()
    this.fields.minute = '0'
    return this
  }

  daily(): this {
    this.hourly()
    this.fields.hour = '0'
    return this
  }

  weekly(): this {
    this.daily()
    this.fields.dayOfWeek = '0'
    return this
  }

  monthly(): this {
    this.daily()
    this.fields.dayOfMonth = '1'
    return this
  }

  /** 'HH:mm' time — combines with daily/weekly/monthly. */
  at(time: string): this {
    const [hour, minute] = time.split(':')
    this.fields.hour = String(Number(hour))
    this.fields.minute = String(Number(minute ?? 0))
    return this
  }

  /** Raw cron expression (5 fields) — escape hatch. */
  cron(expression: string): this {
    this.fields = parseCron(expression)
    return this
  }

  sundays(): this { return this.onDayOfWeek(0) }
  mondays(): this { return this.onDayOfWeek(1) }
  tuesdays(): this { return this.onDayOfWeek(2) }
  wednesdays(): this { return this.onDayOfWeek(3) }
  thursdays(): this { return this.onDayOfWeek(4) }
  fridays(): this { return this.onDayOfWeek(5) }
  saturdays(): this { return this.onDayOfWeek(6) }

  timezone(tz: string): this {
    this.tz = tz
    return this
  }

  /** If the previous execution is still running, the new one is skipped. */
  withoutOverlapping(): this {
    this.noOverlap = true
    return this
  }

  onFailure(handler: (error: unknown) => void): this {
    this.failureHandler = handler
    return this
  }

  /** Entry description — consumed by `basalt schedule list`. */
  describe(): { name: string; cron: string; timezone: string } {
    return { name: this.name, cron: cronToString(this.fields), timezone: this.tz }
  }

  isDue(date: Date): boolean {
    return cronMatches(this.fields, date, this.tz)
  }

  /** @internal runs the task with the overlap guard and failure handling. */
  async run(): Promise<void> {
    if (this.noOverlap && this.running) {
      this.skippedOverlaps++
      return
    }
    this.running = true
    try {
      await this.task()
    } catch (error) {
      if (!this.failureHandler) throw error
      this.failureHandler(error)
    } finally {
      this.running = false
    }
  }

  private onDayOfWeek(day: number): this {
    this.fields.dayOfWeek = String(day)
    return this
  }
}

export class Scheduler {
  private readonly entries: ScheduleEntry[] = []
  private timer: NodeJS.Timeout | undefined
  private interval: NodeJS.Timeout | undefined

  /** Schedules the dispatch of a @basaltkit/queue job. */
  job<T>(job: JobDefinition<T>, ...payload: T extends void ? [] : [T]): ScheduleEntry {
    return this.add(new ScheduleEntry(job.name, () => job.dispatch(payload[0] as T)))
  }

  /** Schedules a named function. */
  call(name: string, task: Task): ScheduleEntry {
    return this.add(new ScheduleEntry(name, task))
  }

  list(): { name: string; cron: string; timezone: string }[] {
    return this.entries.map((entry) => entry.describe())
  }

  /** Names of every scheduled entry — for CLI validation/listing. */
  names(): string[] {
    return this.entries.map((entry) => entry.name)
  }

  /**
   * Runs a single entry by name on demand, ignoring its cron (for `schedule:run`
   * and manual triggers). Returns false if no entry has that name. The entry's
   * own overlap guard and failure handler still apply.
   */
  async runNow(name: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.name === name)
    if (!entry) return false
    await entry.run()
    return true
  }

  /**
   * Runs the entries due at the given instant. Deterministic — this is what
   * the tests call directly and what the timer calls every minute.
   * Failures (without onFailure) are aggregated; all due entries run.
   */
  async tick(date: Date = new Date()): Promise<void> {
    const due = this.entries.filter((entry) => entry.isDue(date))
    const errors: unknown[] = []
    await Promise.all(
      due.map(async (entry) => {
        try {
          await entry.run()
        } catch (error) {
          errors.push(error)
        }
      }),
    )
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failure in ${errors.length} scheduled task(s)`)
    }
  }

  /** Aligns to the next minute and then runs tick() every 60s. */
  start(): void {
    if (this.timer || this.interval) return
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    this.timer = setTimeout(() => {
      void this.safeTick()
      this.interval = setInterval(() => void this.safeTick(), 60_000)
      this.interval.unref?.()
    }, msToNextMinute)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.interval) clearInterval(this.interval)
    this.timer = undefined
    this.interval = undefined
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick()
    } catch {
      // failures without onFailure were already aggregated; here we only avoid
      // bringing down the process — each entry must handle its own failure
    }
  }

  private add(entry: ScheduleEntry): ScheduleEntry {
    this.entries.push(entry)
    return entry
  }
}

export const SCHEDULER = createToken<Scheduler>('scheduler')

export interface SchedulerPluginOptions {
  /** Callback that defines the schedules — receives the Scheduler at boot. */
  define?: (schedule: Scheduler) => void
  /** Starts the timer at boot. Default: true (turn off in tests). */
  autostart?: boolean
}

export function schedulerPlugin(options: SchedulerPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:scheduler',
    register({ container }) {
      container.singleton(SCHEDULER, () => new Scheduler())
      registerScheduleRunCommand(container)
    },
    boot({ container }) {
      const scheduler = container.get(SCHEDULER)
      options.define?.(scheduler)
      // Expose entries to tooling (CLI `basalt schedule:list`).
      const metadata = ensureMetadata(container)
      for (const entry of scheduler.list()) metadata.add('schedule:entries', entry)
      if (options.autostart !== false) scheduler.start()
    },
    shutdown({ container }) {
      container.get(SCHEDULER).stop()
    },
  })
}

/**
 * Registers `schedule:run` into the CLI command bucket. Runs a scheduled task on
 * demand by name (ignoring its cron), or `--due` to run everything due right now.
 * Registered structurally to avoid a hard @basaltkit/cli dependency.
 */
function registerScheduleRunCommand(container: Container): void {
  ensureMetadata(container).add('commands', {
    name: 'schedule:run',
    description: 'Run a scheduled task on demand (by name), or --due for all due now',
    async handle({
      io,
      args,
      flags,
    }: {
      io: { log(m: string): void; error(m: string): void }
      args: string[]
      flags: Record<string, string | boolean>
    }) {
      const scheduler = container.get(SCHEDULER)
      if (flags['due'] === true) {
        await scheduler.tick()
        io.log('Ran all due scheduled tasks.')
        return
      }
      const name = args[0]
      if (!name) {
        io.error('Usage: basalt schedule:run <name> | --due')
        return 1
      }
      const ran = await scheduler.runNow(name)
      if (!ran) {
        const available = scheduler.names().join(', ') || '(none)'
        io.error(`Unknown scheduled task "${name}". Available: ${available}.`)
        return 1
      }
      io.log(`Ran scheduled task "${name}".`)
    },
  })
}
