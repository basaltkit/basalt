# @basaltkit/scheduler

Task scheduler for Basalt applications: define, with a fluent, readable API (`daily().at('03:00')`), tasks that run automatically at set times — backups, reports, cleanups, billing.

You need this module whenever you want something to happen **on a schedule**, rather than in response to a user request.

---

## What this module solves

Many applications need periodic work: deleting expired sessions every night, sending a weekly summary on Sunday, closing billing on the 1st of each month. The traditional way to do this is **cron** — a 5-field format (`minute hour day-of-month month day-of-week`, e.g. `0 3 * * *` = "every day at 03:00") that is powerful but easy to get wrong.

This module lets you declare schedules in readable code — `schedule.call('backup', doBackup).daily().at('03:00')` — without memorizing cron syntax (though it also accepts it as an "escape hatch"). The scheduler wakes up **once a minute**, checks which entries are "due" that minute, and runs them.

It also handles the annoying problems: **timezones** (schedule at 03:00 in Lisbon or São Paulo, not the server's), **overlap** (if the previous run is still in progress, skip the new one with `withoutOverlapping()`), **failures** (`onFailure` handler per entry; without it, the error is aggregated without crashing the process) and **testability** (the `tick(data)` method is deterministic — in tests you call it with a fixed date, with no need to wait on real clocks).

## Installation

```bash
pnpm add @basaltkit/scheduler
```

Depends on `@basaltkit/core` and integrates (optionally) with `@basaltkit/queue`.

## Getting started in 5 minutes

**1. Register the plugin and define the schedules** (e.g. `src/app.ts`):

```ts
import { createApp } from '@basaltkit/core'
import { schedulerPlugin } from '@basaltkit/scheduler'

const app = await createApp({
  plugins: [
    schedulerPlugin({
      define: (schedule) => {
        // every minute
        schedule.call('heartbeat', () => console.log('still alive'))

        // every day at 03:00 UTC
        schedule
          .call('backup', async () => {
            // do the backup…
          })
          .daily()
          .at('03:00')
      },
    }),
  ],
}).boot()
```

**2. There's no step 2.** On `boot`, the plugin calls your `define`, and the internal timer starts on its own (it aligns to the next minute and then checks every 60 seconds). On application `shutdown`, the timer stops.

To see what's scheduled:

```ts
import { SCHEDULER } from '@basaltkit/scheduler'

console.log(app.container.get(SCHEDULER).list())
// [{ name: 'heartbeat', cron: '* * * * *', timezone: 'UTC' },
//  { name: 'backup',    cron: '0 3 * * *', timezone: 'UTC' }]
```

## Usage guide

### Fluent frequencies

Each method returns the entry itself, so they can be chained:

```ts
import { Scheduler } from '@basaltkit/scheduler'

const schedule = new Scheduler()

schedule.call('a', task).everyMinute()          // * * * * *
schedule.call('b', task).everyMinutes(15)       // */15 * * * *
schedule.call('c', task).hourly()               // 0 * * * *   (at minute 0)
schedule.call('d', task).daily()                // 0 0 * * *   (midnight)
schedule.call('e', task).daily().at('03:30')    // 30 3 * * *
schedule.call('f', task).weekly()               // 0 0 * * 0   (Sunday at midnight)
schedule.call('g', task).weekly().sundays().at('08:00') // 0 8 * * 0
schedule.call('h', task).monthly().at('00:30')  // 30 0 1 * *  (the 1st of the month)
schedule.call('i', task).mondays().at('09:00')  // days of the week: sundays()…saturdays()
```

`at('HH:mm')` combines with `daily()`/`weekly()`/`monthly()` — it sets the hour and minute.

### Direct cron expression

When the fluent API isn't enough, pass raw cron (5 fields; supports `*`, `*/n` steps, `a-b` ranges and `a,b,c` lists):

```ts
// every 15 minutes, from 9am to 5pm, Monday to Friday
schedule.call('sync', sync).cron('*/15 9-17 * * 1-5')
```

An invalid expression throws `CronParseError` (code `CRON_INVALID`).

### Timezones

By default, times are interpreted in **UTC**. Use `timezone()` with an IANA name:

```ts
schedule
  .call('report', generateReport)
  .daily()
  .at('03:00')
  .timezone('America/Sao_Paulo') // 03:00 in São Paulo = 06:00 UTC
```

### Avoiding overlap: `withoutOverlapping()`

If a task takes longer than the interval between runs, the new run is **skipped** while the previous one is in progress:

```ts
const entry = schedule
  .call('slow-import', importEverything)
  .everyMinute()
  .withoutOverlapping()

// entry.skippedOverlaps counts the skipped runs (observability/tests)
```

### Handling failures: `onFailure()`

```ts
schedule
  .call('fragile', taskThatMightFail)
  .hourly()
  .onFailure((error) => {
    console.error('task failed', error)
  })
```

- **With** `onFailure`: the error is delivered to the handler and doesn't propagate.
- **Without** `onFailure`: on manual `tick()`, errors from due entries are aggregated into an `AggregateError` (all due entries run in the same call). In automatic mode (timer), the failure is swallowed so as not to crash the process — so in production, always set `onFailure` (or use `schedule.job(...)`, see below, and leave retries to the queue).

### Scheduling queue jobs: `schedule.job()`

Instead of running the task in the scheduler's own process, you can schedule the **dispatch** of an `@basaltkit/queue` job — the heavy lifting runs on the worker, with retries and context:

```ts
import { createApp } from '@basaltkit/core'
import { defineJob, queuePlugin } from '@basaltkit/queue'
import { schedulerPlugin } from '@basaltkit/scheduler'
import { z } from 'zod'

const ReconcileBilling = defineJob({
  name: 'billing.reconcile',
  schema: z.object({ mode: z.string() }),
  async handle({ mode }) { /* reconcile… */ },
})

const app = await createApp({
  plugins: [
    queuePlugin({ jobs: [ReconcileBilling] }),
    schedulerPlugin({
      define: (schedule) => {
        schedule.job(ReconcileBilling, { mode: 'full' }).daily().at('03:00')
      },
    }),
  ],
}).boot()
```

The entry is named after the job (`billing.reconcile`). If the job takes no payload (`T = void`), just call `schedule.job(MyJob)`.

### Testing deterministically

`tick(date)` runs everything due at that exact instant — no real timers involved:

```ts
import { Scheduler } from '@basaltkit/scheduler'

const scheduler = new Scheduler()
let runs = 0
scheduler.call('backup', () => void runs++).daily().at('03:00')

await scheduler.tick(new Date('2026-08-05T10:15:00Z')) // not 03:00 → doesn't run
await scheduler.tick(new Date('2026-08-05T03:00:00Z')) // runs
console.log(runs) // 1
```

In tests with the plugin, pass `autostart: false` so the timer doesn't start.

## API reference

### `schedulerPlugin(options?: SchedulerPluginOptions)`

Registers a `Scheduler` (singleton) under the `SCHEDULER` token; on `boot` it calls `define`, publishes the entries to the container's metadata (key `schedule:entries`, consumed by the `basalt schedule:list` CLI) and starts the timer; on `shutdown` it calls `stop()`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `define` | `(schedule: Scheduler) => void` | No | — | Callback where you declare the schedules (receives the Scheduler at boot). |
| `autostart` | `boolean` | No | `true` | Starts the timer at boot. Turn off in tests. |

### `class Scheduler`

| Method | Signature | Description |
|---|---|---|
| `call` | `(name: string, task: () => void \| Promise<void>) => ScheduleEntry` | Schedules a function with a name. |
| `job` | `<T>(job: JobDefinition<T>, payload?) => ScheduleEntry` | Schedules the `dispatch` of an `@basaltkit/queue` job (payload required if the job needs one). |
| `list` | `() => { name, cron, timezone }[]` | Describes all entries. |
| `tick` | `(date?: Date) => Promise<void>` | Runs the entries due at that instant (default: now). Aggregates failures without `onFailure` into an `AggregateError`. |
| `start` | `() => void` | Aligns to the next minute and then `tick()`s every 60s. Idempotent. |
| `stop` | `() => void` | Stops the timers. |

### `class ScheduleEntry` (returned by `call`/`job`)

Frequency methods (all return `this`): `everyMinute()`, `everyMinutes(n)`, `hourly()`, `daily()`, `weekly()`, `monthly()`, `at('HH:mm')`, `cron(expression)`, `sundays()`, `mondays()`, `tuesdays()`, `wednesdays()`, `thursdays()`, `fridays()`, `saturdays()`.

| Method/property | Type | Default | Description |
|---|---|---|---|
| `timezone(tz)` | `(tz: string) => this` | `'UTC'` | IANA timezone in which the time is interpreted. |
| `withoutOverlapping()` | `() => this` | off | Skips the run if the previous one is still in progress. |
| `onFailure(handler)` | `((error: unknown) => void) => this` | — | Receives the error instead of propagating it. |
| `describe()` | `() => { name, cron, timezone }` | — | Description of the entry. |
| `isDue(date)` | `(date: Date) => boolean` | — | Is the entry due at this instant? |
| `skippedOverlaps` | `number` | `0` | Counter of runs skipped due to overlap. |
| `run()` | `() => Promise<void>` | — | **Advanced/internal**: runs with overlap guard and failure handling. |

Without any frequency method, the entry runs **every minute** (initial cron fields are `* * * * *`).

### Cron utilities (Advanced)

Exported for tooling and tests; you don't usually need them:

| Export | Signature | Description |
|---|---|---|
| `parseCron` | `(expression: string) => CronFields` | Splits a 5-field expression; throws `CronParseError` if invalid. |
| `cronMatches` | `(fields: CronFields, date: Date, timeZone?: string) => boolean` | Does the instant match the expression (in the given timezone)? |
| `fieldMatches` | `(field: string, value: number) => boolean` | Does a field (`*`, `*/n`, `a-b`, `a,b,c`, value) accept the number? |
| `zonedParts` | `(date: Date, timeZone = 'UTC') => ZonedParts` | Breaks the instant down into minute/hour/day/month/day-of-week in the timezone. |
| `CronParseError` | class (`BasaltError`, code `CRON_INVALID`) | Invalid cron expression. |
| `CronFields`, `ZonedParts` | types | Cron fields as strings; numeric parts of the instant. |

### Token

- `SCHEDULER: Token<Scheduler>` — to get the Scheduler from the container: `app.container.get(SCHEDULER)`.

## Common errors and solutions (FAQ)

**My `daily().at('03:00')` task runs at the wrong time.**
Times are UTC by default. Add `.timezone('Europe/Lisbon')` (or your IANA timezone).

**`CronParseError: expected 5 fields`.**
`cron()` only accepts the classic 5-field format (`min hour day month day-of-week`). 6-field formats (with seconds) are not supported.

**The task runs twice (two servers).**
The scheduler runs in every process where the plugin starts. If you have multiple replicas, enable the scheduler on only one (e.g. via an environment variable) or schedule `schedule.job(...)` with idempotent jobs.

**A task failed and I didn't see anything.**
In automatic mode, failures without `onFailure` are silenced so as not to crash the process. Set `onFailure` on each entry (or log inside it).

**I need second-level precision.**
Not possible — the resolution is the minute (the `tick` runs every 60s), just like classic cron.

**In tests, the process doesn't exit.**
Pass `autostart: false` to the plugin, or call `scheduler.stop()`. (The timers use `unref()`, so they usually don't hold the process open, but in tests it's best not to start them.)

## How it connects to other modules

- **`@basaltkit/core`** — `schedulerPlugin` is a core plugin (register/boot/shutdown); entries are published to the container's metadata registry (`ensureMetadata` → key `schedule:entries`) for the `basalt schedule:list` CLI; `CronParseError` extends `BasaltError`.
- **`@basaltkit/queue`** — `schedule.job(MyJob, payload)` schedules a job's *dispatch*: the scheduler only enqueues it; execution, retries and context are handled by the queue and its workers. This is the recommended pattern for heavy or critical tasks.
- **`@basaltkit/logger`** — use the logger inside tasks/`onFailure` to get structured traces of the runs.
- **`@basaltkit/audit` / `@basaltkit/activity`** — scheduled tasks can record audit or activity entries (e.g. `audit.record('maintenance.run')`) to leave a trail of the automated work.
