<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

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

## CLI commands (`basalt schedule:*`)

```bash
basalt schedule:list                 # every scheduled task + its cron (from metadata)
basalt schedule:run reconcile-billing  # run one task NOW, ignoring its cron
basalt schedule:run --due            # run everything due at this instant (a manual tick)
```

`schedule:list` reads the `schedule:entries` metadata bucket; `schedule:run` is
registered by `schedulerPlugin` and executes against the live `Scheduler`, so it
respects each entry's overlap guard and `onFailure` handler.

## API reference

### `schedulerPlugin(options?: SchedulerPluginOptions)`

Registers a `Scheduler` (singleton) under the `SCHEDULER` token; on `boot` it calls `define`, publishes the entries to the container's metadata (key `schedule:entries`, consumed by `basalt schedule:list`), registers the `schedule:run` command, and starts the timer; on `shutdown` it calls `stop()`.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `define` | `(schedule: Scheduler) => void` | — | Callback where you declare the schedules (receives the Scheduler at boot). |
| `autostart` | `boolean` | `true` | Starts the timer at boot. Turn it off in tests so the process isn't holding a 60 s interval. |
| `lock` | `ScheduleLock` | — | Cross-replica mutex, **required** as soon as any entry calls `.onOneServer()`. Boot throws without it. See [`ScheduleLock`](#the-schedulelock-contract). |
| `lockTtlMs` | `number` | `60_000` | TTL of each per-entry, per-tick lock key. The key already embeds the minute, so this only has to outlive clock skew between replicas — one tick window is the right default. |

`SchedulerOptions` (`lock`, `lockTtlMs`) are the same two the `Scheduler` constructor takes, so a
hand-built `new Scheduler({ lock })` behaves identically.

### `class Scheduler`

| Method | Signature | Description |
|---|---|---|
| `call` | `(name: string, task: () => void \| Promise<void>) => ScheduleEntry` | Schedules a function with a name. |
| `job` | `<T>(job: JobDefinition<T>, payload?) => ScheduleEntry` | Schedules the `dispatch` of an `@basaltkit/queue` job (payload required if the job needs one). |
| `list` | `() => { name, cron, timezone }[]` | Describes all entries. |
| `names` | `() => string[]` | Names of every entry — used by the CLI to validate/suggest. |
| `runNow` | `(name: string) => Promise<boolean>` | Runs one entry on demand, **ignoring its cron and its `.onOneServer()` lock** (a manual trigger is deliberate). `false` if no entry has that name. The overlap guard and `onFailure` still apply. |
| `tick` | `(date?: Date) => Promise<void>` | Runs the entries due at that instant (default: now), concurrently. Aggregates failures without `onFailure` into an `AggregateError`. |
| `start` | `() => void` | Aligns to the next minute and then `tick()`s every 60s. Idempotent; the timers are `unref`'d. |
| `stop` | `() => void` | Stops the timers. |
| `skippedByLock` | `number` | Ticks skipped because another replica held the lock — for observability and tests. |

### `class ScheduleEntry` (returned by `call`/`job`)

Frequency methods (all return `this`): `everyMinute()`, `everyMinutes(n)`, `hourly()`, `daily()`, `weekly()`, `monthly()`, `at('HH:mm')`, `cron(expression)`, `sundays()`, `mondays()`, `tuesdays()`, `wednesdays()`, `thursdays()`, `fridays()`, `saturdays()`.

| Method/property | Type | Default | Description |
|---|---|---|---|
| `timezone(tz)` | `(tz: string) => this` | `'UTC'` | IANA timezone in which the time is interpreted. |
| `withoutOverlapping()` | `() => this` | off | Skips the run if the previous one is still in progress — **in this process only**. |
| `onOneServer()` | `() => this` | off | Runs the entry on exactly ONE replica per tick instead of on every pod. Requires `schedulerPlugin({ lock })`; boot throws without one. |
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

### Errors

| Error | Code | When |
|---|---|---|
| `CronParseError` | `CRON_INVALID` | An expression passed to `.cron()` (or built internally) isn't 5 fields, uses unsupported syntax (`MON`, `@daily`, `?`, `L`), has a reversed range (`5-1`), a step below 1, or a value outside its field's bounds. Extends `BasaltError`; raised at **definition** time, so a typo fails at boot rather than becoming a task that silently never fires. |
| `Error` (plain) | — | At `boot`, when an entry uses `.onOneServer()` but no `lock` was configured. See [Boot-time enforcement](#boot-time-enforcement). |
| `AggregateError` | — (built-in) | From `tick()`, when one or more due entries failed without an `onFailure` handler — or when a `.onOneServer()` entry's `lock.acquire` rejected. All due entries still ran; `error.errors` holds each failure. Swallowed by the automatic timer path so a failing task can't kill the process. |

### Hooks & callbacks

The scheduler has no hook bus. Two per-entry callbacks and one injected collaborator:

| Callback | Where | Receives | Default when unset |
|---|---|---|---|
| `onFailure(handler)` | `ScheduleEntry` | `(error: unknown)` | The error propagates — aggregated into the tick's `AggregateError`, then **swallowed** by the automatic timer. Set it, or a failure in production is invisible. |
| `lock.acquire` | `SchedulerOptions` | `(key: string, ttlMs: number) => Promise<boolean>` | No lock. Boot throws if any entry needs one. |

## Multiple replicas — `.onOneServer()`

`withoutOverlapping()` guards one process. It does nothing about the real production problem:
you run four pods, every pod boots the scheduler, and at 03:00 the nightly billing job runs
**four times**. Mark the entry `.onOneServer()` and give the plugin a lock:

```ts
import Redis from 'ioredis'
import { schedulerPlugin, type ScheduleLock } from '@basaltkit/scheduler'

const redis = new Redis(process.env.REDIS_URL!)

const lock: ScheduleLock = {
  async acquire(key, ttlMs) {
    return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK'
  },
}

schedulerPlugin({
  lock,
  define: (schedule) => {
    schedule.job(ReconcileBilling, { mode: 'full' }).daily().at('03:00').onOneServer()
  },
})
```

### The `ScheduleLock` contract

```ts
interface ScheduleLock {
  acquire(key: string, ttlMs: number): Promise<boolean>
}
```

One method, and the guarantees it must provide are the whole point:

- **`acquire` must be atomic across processes.** For a given `key`, exactly one caller anywhere
  in the fleet may get `true` until the TTL expires. Redis `SET key value PX ttl NX` is the
  canonical implementation. A check-then-set (`GET` then `SET`) is **not** atomic and silently
  reintroduces the duplicate runs you added the lock to prevent.
- **The key must actually expire.** The scheduler never deletes it. A store without TTL support
  would let the first tick's key block that entry forever.
- **There is deliberately no `release`.** The key covers the whole tick window, so a fast first
  run cannot be followed by a late replica acquiring the freed key and running the same minute a
  second time. The TTL is the release.

The key the scheduler builds is `basalt:schedule:<entry name>:<minute, ISO, seconds zeroed>` —
one key per entry per minute. `lockTtlMs` (default `60_000`) only has to outlive clock skew
between replicas.

### What happens when acquisition fails

Two distinct cases, and they are treated very differently:

| Case | Behaviour |
|---|---|
| `acquire` resolves `false` — another replica won this tick | The entry is skipped on this replica and `scheduler.skippedByLock` increments. This is the normal path on N−1 of your N pods, every tick. Not an error. |
| `acquire` **rejects** — the lock store is down, times out, or the credentials expired | Treated as a **task failure**: the rejection is collected into the tick's `AggregateError` exactly like a thrown task, so it is visible. The entry does **not** run. It is *not* treated as permission to proceed. |

That last row is the deliberate design choice. Failing open — running everywhere when the lock
store is unreachable — would mean a Redis outage silently turns one nightly billing run into
four. Failing closed means a Redis outage skips a tick, which a subsequent tick or a manual
`basalt schedule:run <name>` can recover.

### Boot-time enforcement

If any entry calls `.onOneServer()` and no `lock` was configured, `boot` **throws**:

```
schedulerPlugin: an entry uses .onOneServer() but no `lock` was configured.
Pass `schedulerPlugin({ lock })` with an atomic cross-replica lock (e.g. Redis SET NX PX) — see ScheduleLock.
```

Failing the deploy is the point: silently running the entry on every replica is exactly the
failure mode `.onOneServer()` exists to prevent, and it is invisible until the duplicate charges
land.

### What the lock does not cover

- **`runNow()` / `basalt schedule:run <name>`** bypass the lock entirely — a manual trigger is
  deliberate, and you asked *this* process to run it.
- **Entries without `.onOneServer()`** are untouched and still run on every replica.
- **The lock is per tick, not per run.** If a task overruns its minute, the next minute's key is
  a different key. Combine with `.withoutOverlapping()` if the same replica must not stack runs,
  and prefer `schedule.job(...)` so a queue worker (with its own idempotency) does the work.

Cron expressions are validated at definition time — `CronParseError` on unsupported syntax like
`MON` or out-of-range values, so a typo fails at boot instead of becoming a job that never fires.

## Common errors and solutions (FAQ)

**My `daily().at('03:00')` task runs at the wrong time.**
Times are UTC by default. Add `.timezone('Europe/Lisbon')` (or your IANA timezone).

**`CronParseError: expected 5 fields`.**
`cron()` only accepts the classic 5-field format (`min hour day month day-of-week`). 6-field formats (with seconds) are not supported.

**The task runs twice (two servers).**
The scheduler runs in every process where the plugin starts. Mark the entry `.onOneServer()` and pass `schedulerPlugin({ lock })` an atomic cross-replica lock — see the *Multiple replicas* section above. `withoutOverlapping()` will not help: it guards one process only.

**Boot fails with "an entry uses .onOneServer() but no `lock` was configured".**
Exactly as intended — booting without the lock would run that entry on every replica. Supply a `ScheduleLock` (Redis `SET key v PX ttl NX`), or drop `.onOneServer()`.

**An `.onOneServer()` entry stopped running everywhere at once.**
Its lock store is unreachable. A rejecting `acquire` is treated as a task failure (visible in the tick's `AggregateError`), never as permission to run on every replica. Fix the store; a later tick or `basalt schedule:run <name>` recovers the missed run.

**`skippedByLock` keeps climbing.**
Normal. On N replicas, N−1 of them skip each `.onOneServer()` tick. Only worry if it climbs on *every* replica — that means nobody is acquiring, i.e. a stale key without a TTL.

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
