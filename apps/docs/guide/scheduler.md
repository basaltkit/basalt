# Scheduled tasks

[`@basaltkit/scheduler`](/reference/packages/scheduler) runs work **on a schedule** —
nightly backups, weekly reports, monthly billing — declared in readable code instead
of raw cron. The scheduler wakes once a minute, checks what's due, and runs it.

[[toc]]

## How a tick works

On `boot` the plugin runs your `define` callback, registers the entries, and
aligns a timer to the next minute. Every 60 seconds it runs a **tick**:

1. Select the entries whose cron matches the current minute, evaluated in each
   entry's `timezone` (default UTC).
2. For an `.onOneServer()` entry, acquire the cross-replica lock key
   `basalt:schedule:<name>:<minute ISO>` — exactly one replica gets it; the
   others skip this minute (counted in `scheduler.skippedByLock`).
3. For a `.withoutOverlapping()` entry whose previous run is still going, skip
   (counted in `entry.skippedOverlaps`).
4. Run the task. An error goes to the entry's `onFailure` handler; without one,
   failures across the tick are aggregated into an `AggregateError` — every due
   entry still runs, and the process never crashes because a task threw.

The scheduler fails **loud and early** everywhere it can: an invalid cron
expression throws `CronParseError` at definition time, `.onOneServer()` without
a lock fails the boot, and a lock-store failure counts as a task failure — never
a silent no-op.

## Define schedules

Register the plugin and declare tasks with a fluent API:

```ts
import { createApp } from '@basaltkit/core'
import { schedulerPlugin, SCHEDULER } from '@basaltkit/scheduler'

const app = await createApp({
  plugins: [
    schedulerPlugin({
      define: (schedule) => {
        schedule.call('heartbeat', () => log('alive'))          // every minute

        schedule.call('backup', doBackup).daily().at('03:00')   // 03:00 every day

        schedule.call('weekly-report', sendReport)
          .weekly().at('09:00')                                 // Sundays at 09:00

        schedule.call('close-billing', closeBilling)
          .monthly().at('00:00')                                // 1st of the month
      },
    }),
  ],
}).boot()
```

There's no start step — the timer aligns to the next minute on `boot` and stops on
`shutdown`. Inspect the registry with `app.container.get(SCHEDULER).list()`.

Every entry builder, at a glance:

| Builder | Effect |
| --- | --- |
| `.everyMinute()` | Every minute (the default). |
| `.everyMinutes(n)` | Minutes divisible by `n` (`*/n`). |
| `.hourly()` | Minute 0 of every hour. |
| `.daily()` / `.weekly()` / `.monthly()` | 00:00 daily / Sundays / the 1st — combine with `.at()`. |
| `.at('HH:mm')` | Sets the time for `daily`/`weekly`/`monthly`. |
| `.sundays()` … `.saturdays()` | Pins the day of week. |
| `.cron('*/5 * * * *')` | Raw 5-field cron — the escape hatch, validated at definition time. |
| `.timezone('Europe/Lisbon')` | Evaluates the cron in that IANA zone. Default `UTC`. |
| `.withoutOverlapping()` | Skips a run while the previous one is still going (this process). |
| `.onOneServer()` | Runs on one replica per tick — requires a `lock` (below). |
| `.onFailure(handler)` | Per-task error handler — without it, failures are aggregated per tick. |

`schedule.call(name, fn)` runs a function; `schedule.job(JobDef, payload?)`
dispatches a [queue job](/guide/queues) instead (see below).

## Timezones, overlap & failures

Real schedules need more than a time — the module handles the sharp edges:

```ts
schedule.call('digest', sendDigest)
  .daily().at('07:00').timezone('Europe/Lisbon')  // local time, not the server's
  .withoutOverlapping()                            // skip if the last run is still going
  .onFailure((err) => report(err))                 // per-task error handler
```

Without `onFailure`, errors are aggregated without crashing the process. Need raw
cron? `schedule.call('x', fn).cron('*/5 * * * *')` is the escape hatch — the
expression is validated at definition time (supported syntax: `*`, `*/n`, single
values, `a-b` ranges, comma lists; names like `MON` are rejected with a
`CronParseError` instead of silently never firing).

## Multiple replicas: `.onOneServer()`

`withoutOverlapping()` guards ONE process. On a horizontally-scaled deployment
every replica has its own scheduler, so a plain `daily()` entry runs on every
pod — N× your billing reconciliation. Mark the entry `.onOneServer()` and give
the plugin an atomic cross-replica lock (any store with a set-if-absent + TTL;
Redis shown):

```ts
import { schedulerPlugin, type ScheduleLock } from '@basaltkit/scheduler'

const lock: ScheduleLock = {
  async acquire(key, ttlMs) {
    return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK'
  },
}

schedulerPlugin({
  lock,
  define: (schedule) => {
    schedule.job(ReconcileBilling).daily().at('03:00').onOneServer()
  },
})
```

The `ScheduleLock` contract is one method — `acquire(key, ttlMs)` — and it must
be **atomic across processes** (set-if-absent, like Redis `SET key value PX ttl
NX`): it returns `true` for exactly one caller per key until the TTL expires.
The scheduler builds one key **per entry per minute**
(`basalt:schedule:<name>:<minute ISO>`), so exactly one replica runs the entry
and the others skip that tick (visible in `scheduler.skippedByLock`). There is
deliberately no `release`: the key covers the whole tick window, so a fast first
run can't be followed by a late replica re-acquiring and running the same minute
again.

Two fail-closed rules keep this honest:

- **`.onOneServer()` without a `lock` fails loud at boot** — silently running on
  every replica is the failure mode this exists to prevent.
- **A lock-store failure (e.g. Redis down) counts as a task failure** — visible
  through `onFailure`/the tick's `AggregateError` — instead of being treated as
  permission for every replica to run at once.

Manual triggers (`runNow`, `basalt schedule:run`) bypass the lock on purpose — a
manual trigger is deliberate.

## Queue integration & testing

Hand heavy work to a queue instead of running it inline — `schedule.job(...)`
dispatches a [`@basaltkit/queue`](/guide/queues) job when the entry is due:

```ts
schedule.job(GenerateReport, { month: '2026-01' }).monthly().at('02:00')
```

Because scheduling is time-based, testing is deterministic: call `tick(date)` with a
fixed date and assert which entries ran — no waiting on real clocks.

```ts
scheduler.tick(new Date('2026-01-01T03:00:00Z')) // runs everything due that minute
```

## Run on demand

`schedule:run` triggers an entry from the CLI, ignoring its cron — for testing a
schedule or re-running a failed one:

```bash
basalt schedule:run close-billing   # run one entry now
basalt schedule:run --due           # run everything due this minute
```

Programmatically, `scheduler.runNow(name)` does the same (returns `false` for an
unknown name). Both bypass the `.onOneServer()` lock — the entry's own overlap
guard and `onFailure` handler still apply.

## Options reference

`schedulerPlugin(options)`:

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `define` | `(schedule: Scheduler) => void` | — | Declares the entries at boot. |
| `autostart` | `boolean` | `true` | Starts the minute timer on boot. Set `false` in tests and drive `tick(date)` yourself. |
| `lock` | `ScheduleLock` | — | Atomic cross-replica set-if-absent lock. **Required** as soon as any entry uses `.onOneServer()` — boot fails without it. |
| `lockTtlMs` | `number` | `60_000` | TTL of each per-entry, per-minute lock key. One tick window — the key embeds the minute, so it only needs to outlive clock skew between replicas. |

## Failure modes & troubleshooting

| If you see | It means | Do |
| --- | --- | --- |
| Boot throws `schedulerPlugin: an entry uses .onOneServer() but no 'lock' was configured.` | Fail-closed guard: without a lock the entry would silently run on every replica | Pass `schedulerPlugin({ lock })` with an atomic set-if-absent lock |
| `CronParseError` (code `CRON_INVALID`) at definition | The cron expression uses unsupported syntax (names like `MON`), an out-of-range value, or a reversed range — it would otherwise silently never fire | Fix the expression; supported: `*`, `*/n`, single values, `a-b`, comma lists |
| `AggregateError: Failure in N scheduled task(s)` | Tasks without `onFailure` threw during a tick; every due entry still ran and the process survived | Add `.onFailure()` to route each task's errors to your reporting |
| A task runs N times at once across pods | The entry lacks `.onOneServer()` (or replicas point at different lock stores) | Mark it `.onOneServer()`; share one lock store across replicas |
| An `.onOneServer()` task failed the tick while Redis was down | Fail closed: a lock-store failure is a task failure, never permission to run everywhere | Restore the lock store; the next minute's tick recovers |
| A task silently skipped a minute | Overlap guard or lock: check `entry.skippedOverlaps` and `scheduler.skippedByLock` counters | Expected behavior — lengthen the interval if runs routinely overlap |
| `Unknown scheduled task "x"` from `schedule:run` | The name doesn't match any entry | `basalt schedule:run` prints the available names — use one of those |

## See also

- [Queues & jobs](/guide/queues) — where `schedule.job(...)` dispatches to.
