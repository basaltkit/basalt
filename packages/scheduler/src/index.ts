import { BasaltError, createToken, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import type { JobDefinition } from '@basaltkit/queue'
import { cronMatches, cronToString, parseCron, type CronFields } from './cron.js'

export { CronParseError, cronMatches, parseCron, fieldMatches, zonedParts } from './cron.js'
export type { CronFields, ZonedParts } from './cron.js'

type Task = () => void | Promise<void>

/**
 * A schedule entry was defined inconsistently. Thrown while the `define`
 * callback builds the entry, so the app fails at boot instead of running a
 * task on the wrong cadence.
 *
 * - `SCHEDULE_CONFLICT`: two frequencies on one entry (`.daily().monthly()`),
 *   `.at()` with a frequency it can't refine (or called twice), or a
 *   day-of-week modifier combined with `.cron()`.
 * - `SCHEDULE_INVALID_TIME`: `.at()` received something other than `HH:mm`.
 */
export class ScheduleDefinitionError extends BasaltError {
  constructor(code: 'SCHEDULE_CONFLICT' | 'SCHEDULE_INVALID_TIME', message: string) {
    super(code, message)
  }
}

type FrequencyKind = 'everyMinute' | 'everyMinutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron'

/** Frequencies whose hour/minute `.at()` may set. */
const TIME_FREQUENCIES: ReadonlySet<FrequencyKind> = new Set<FrequencyKind>(['daily', 'weekly', 'monthly'])

const EVERY_MINUTE: CronFields = { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' }

const DAY_MODIFIERS = ['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays'] as const

const formatTime = ({ hour, minute }: { hour: number; minute: number }): string =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

/**
 * Cross-replica mutex for `.onOneServer()` entries. `acquire` must be ATOMIC
 * across processes (e.g. Redis `SET key value PX ttl NX`): it returns true for
 * exactly one caller per key until the TTL expires. There is deliberately no
 * `release` — the key covers the tick window, so a fast first run cannot be
 * followed by a late replica re-acquiring and running the same minute again.
 *
 * ioredis example:
 *
 *     const lock: ScheduleLock = {
 *       async acquire(key, ttlMs) {
 *         return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK'
 *       },
 *     }
 */
export interface ScheduleLock {
  acquire(key: string, ttlMs: number): Promise<boolean>
}

/**
 * A scheduled entry, built fluently:
 *
 * schedule.job(ReconcileBilling).daily().at('03:00').timezone('UTC')
 * schedule.call('purge-cache', () => cache.flush()).everyMinute().withoutOverlapping()
 *
 * An entry has exactly ONE frequency (`everyMinute`, `everyMinutes`, `hourly`,
 * `daily`, `weekly`, `monthly`, `cron`); a second one throws
 * {@link ScheduleDefinitionError} instead of silently replacing the first.
 */
export class ScheduleEntry {
  /** Effective cron fields, recomputed from frequency, time and day of week. */
  private fields: CronFields = { ...EVERY_MINUTE }
  /** The single frequency call (`.daily()`, `.cron('…')`, …). */
  private frequency: { call: string; kind: FrequencyKind; fields: CronFields } | undefined
  /** The `.at('HH:mm')` call, if any. */
  private time: { call: string; hour: number; minute: number } | undefined
  /** The last day-of-week modifier (`.mondays()`, …), if any. */
  private day: { call: string; value: number } | undefined
  private tz = 'UTC'
  private noOverlap = false
  private oneServer = false
  private failureHandler: ((error: unknown) => void) | undefined
  private running = false
  /** count of executions skipped due to overlap — visible for observability/tests */
  skippedOverlaps = 0

  constructor(
    readonly name: string,
    private readonly task: Task,
  ) {}

  everyMinute(): this {
    return this.setFrequency('everyMinute', '.everyMinute()', {})
  }

  everyMinutes(n: number): this {
    return this.setFrequency('everyMinutes', `.everyMinutes(${n})`, { minute: `*/${n}` })
  }

  hourly(): this {
    return this.setFrequency('hourly', '.hourly()', { minute: '0' })
  }

  daily(): this {
    return this.setFrequency('daily', '.daily()', { minute: '0', hour: '0' })
  }

  weekly(): this {
    return this.setFrequency('weekly', '.weekly()', { minute: '0', hour: '0', dayOfWeek: '0' })
  }

  monthly(): this {
    return this.setFrequency('monthly', '.monthly()', { minute: '0', hour: '0', dayOfMonth: '1' })
  }

  /**
   * 'HH:mm' (or 'H:mm') time. Combines with daily/weekly/monthly, or with no
   * frequency; throws after everyMinute/everyMinutes/hourly/cron and when
   * called twice.
   */
  at(time: string): this {
    const call = `.at('${time}')`
    const match = /^(\d{1,2}):(\d{2})$/.exec(time)
    const hour = Number(match?.[1])
    const minute = Number(match?.[2])
    if (!match || hour > 23 || minute > 59) {
      throw new ScheduleDefinitionError(
        'SCHEDULE_INVALID_TIME',
        `Schedule "${this.name}": invalid time in ${call} — expected 'HH:mm' (hour 0-23, minute 0-59).`,
      )
    }
    if (this.time) this.conflict(call, this.time.call, 'an entry has one time.')
    if (this.frequency && !TIME_FREQUENCIES.has(this.frequency.kind)) {
      this.conflict(
        call,
        this.frequency.call,
        this.frequency.kind === 'cron'
          ? '.cron() is the full expression; put the time in it.'
          : `.at() only combines with .daily(), .weekly() or .monthly(). Use .daily()${call} instead.`,
      )
    }
    this.time = { call, hour, minute }
    return this.compose()
  }

  /** Raw cron expression (5 fields) — escape hatch. It is the entry's frequency. */
  cron(expression: string): this {
    return this.setFrequency('cron', `.cron('${expression}')`, parseCron(expression))
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

  /**
   * On a horizontally-scaled deployment, run this entry on ONE replica per tick
   * instead of on every pod. Requires a `lock` on the Scheduler (see
   * {@link ScheduleLock}) — without one, boot fails loud rather than silently
   * running the job N times. `runNow()`/`schedule:run` bypass the lock (a manual
   * trigger is deliberate).
   */
  onOneServer(): this {
    this.oneServer = true
    return this
  }

  /** @internal whether this entry asked for cross-replica locking. */
  get wantsOneServer(): boolean {
    return this.oneServer
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
    const call = `.${DAY_MODIFIERS[day]}()`
    if (this.frequency?.kind === 'cron') {
      this.conflict(call, this.frequency.call, '.cron() is the full expression; put the day of week in it.')
    }
    this.day = { call, value: day }
    return this.compose()
  }

  /**
   * Records the entry's one frequency. A second frequency used to silently
   * overwrite the first (`.daily().monthly()` ran monthly); now it fails at
   * definition time, i.e. at boot.
   */
  private setFrequency(kind: FrequencyKind, call: string, fields: Partial<CronFields>): this {
    if (this.frequency) {
      this.conflict(
        call,
        this.frequency.call,
        TIME_FREQUENCIES.has(kind)
          ? `an entry has one frequency. Use ${call}.at('${this.time ? formatTime(this.time) : 'HH:mm'}') instead.`
          : 'an entry has one frequency. Keep only the one you mean, or use .cron() for a custom expression.',
      )
    }
    if (this.time && !TIME_FREQUENCIES.has(kind)) {
      this.conflict(call, this.time.call, '.at() only combines with .daily(), .weekly() or .monthly().')
    }
    if (kind === 'cron' && this.day) {
      this.conflict(call, this.day.call, '.cron() is the full expression; put the day of week in it.')
    }
    this.frequency = { call, kind, fields: { ...EVERY_MINUTE, ...fields } }
    return this.compose()
  }

  /** Frequency fields, overlaid with the `.at()` time and the day-of-week modifier. */
  private compose(): this {
    const fields = { ...(this.frequency?.fields ?? EVERY_MINUTE) }
    if (this.time) {
      fields.hour = String(this.time.hour)
      fields.minute = String(this.time.minute)
    }
    if (this.day) fields.dayOfWeek = String(this.day.value)
    this.fields = fields
    return this
  }

  private conflict(call: string, previous: string, hint: string): never {
    throw new ScheduleDefinitionError(
      'SCHEDULE_CONFLICT',
      `Schedule "${this.name}": ${call} conflicts with ${previous} — ${hint}`,
    )
  }
}

export interface SchedulerOptions {
  /** Cross-replica lock for `.onOneServer()` entries. */
  lock?: ScheduleLock
  /**
   * TTL for each per-entry, per-tick lock key. Default 60_000 (one tick window
   * — the key embeds the minute, so it only needs to outlive clock skew).
   */
  lockTtlMs?: number
}

export class Scheduler {
  private readonly entries: ScheduleEntry[] = []
  private timer: NodeJS.Timeout | undefined
  private interval: NodeJS.Timeout | undefined
  private readonly lock: ScheduleLock | undefined
  private readonly lockTtlMs: number
  /** ticks skipped because another replica held the lock — for observability/tests */
  skippedByLock = 0

  constructor(options: SchedulerOptions = {}) {
    this.lock = options.lock
    this.lockTtlMs = options.lockTtlMs ?? 60_000
  }

  /** @internal true when any entry requested `.onOneServer()`. */
  get needsLock(): boolean {
    return this.entries.some((entry) => entry.wantsOneServer)
  }

  /** @internal whether a lock was configured. */
  get hasLock(): boolean {
    return this.lock !== undefined
  }

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
          if (entry.wantsOneServer && this.lock) {
            // One key per entry per tick window: exactly one replica acquires
            // it; the others skip this minute's run. A lock-store failure is
            // treated as a task failure (visible), not as permission to run on
            // every replica at once.
            const minute = new Date(date)
            minute.setSeconds(0, 0)
            const key = `basalt:schedule:${entry.name}:${minute.toISOString()}`
            if (!(await this.lock.acquire(key, this.lockTtlMs))) {
              this.skippedByLock++
              return
            }
          }
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

export interface SchedulerPluginOptions extends SchedulerOptions {
  /** Callback that defines the schedules — receives the Scheduler at boot. */
  define?: (schedule: Scheduler) => void
  /** Starts the timer at boot. Default: true (turn off in tests). */
  autostart?: boolean
}

export function schedulerPlugin(options: SchedulerPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:scheduler',
    register({ container }) {
      container.singleton(
        SCHEDULER,
        () =>
          new Scheduler({
            ...(options.lock ? { lock: options.lock } : {}),
            ...(options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
          }),
      )
      registerScheduleRunCommand(container)
    },
    boot({ container }) {
      const scheduler = container.get(SCHEDULER)
      options.define?.(scheduler)
      if (scheduler.needsLock && !scheduler.hasLock) {
        // Fail closed at boot: silently running the entry on every replica is
        // exactly the failure mode .onOneServer() exists to prevent.
        throw new Error(
          'schedulerPlugin: an entry uses .onOneServer() but no `lock` was configured. ' +
            'Pass `schedulerPlugin({ lock })` with an atomic cross-replica lock (e.g. Redis SET NX PX) — see ScheduleLock.',
        )
      }
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
