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
expression throws `CronParseError` at definition time, an entry with two
frequencies (or a malformed `.at()`) throws `ScheduleDefinitionError` at boot,
`.onOneServer()` without a lock fails the boot, and a lock-store failure counts
as a task failure — never a silent no-op.

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
| `.at('HH:mm')` | Sets the time. Only with `daily`/`weekly`/`monthly` (or no frequency, meaning daily), once per entry. |
| `.sundays()` … `.saturdays()` | Pins the day of week. Not with `.cron()`. |
| `.cron('*/5 * * * *')` | Raw 5-field cron — the escape hatch, validated at definition time. It is the entry's frequency. |
| `.timezone('Europe/Lisbon')` | Evaluates the cron in that IANA zone. Default `UTC`. |
| `.withoutOverlapping()` | Skips a run while the previous one is still going (this process). |
| `.onOneServer()` | Runs on one replica per tick — requires a `lock` (below). |
| `.onFailure(handler)` | Per-task error handler — without it, failures are aggregated per tick. |

`schedule.call(name, fn)` runs a function; `schedule.job(JobDef, payload?)`
dispatches a [queue job](/guide/queues) instead (see below).

### One frequency per entry

`everyMinute`, `everyMinutes`, `hourly`, `daily`, `weekly`, `monthly` and `cron`
are **frequencies**, and an entry has exactly one. A second one throws
`ScheduleDefinitionError` (code `SCHEDULE_CONFLICT`) while `define` runs, so the
app fails at boot instead of quietly running on whichever call came last:

```ts
schedule.call('backup', doBackup).daily().monthly()
// ✗ Schedule "backup": .monthly() conflicts with .daily() — an entry has one
//   frequency. Use .monthly().at('HH:mm') instead.

schedule.call('backup', doBackup).monthly().at('03:00')  // ✓ one frequency + a time
```

`.at('HH:mm')` refines a frequency, so the valid combinations are:

| Chain | Valid? |
| --- | --- |
| `.daily().at()` / `.weekly().at()` / `.monthly().at()` | ✓ |
| `.at()` with no frequency, or before `daily`/`weekly`/`monthly` | ✓ (the order doesn't matter) |
| `.weekly().mondays().at('07:30')` | ✓ |
| `.everyMinute()` / `.everyMinutes(n)` / `.hourly()` / `.cron()` + `.at()` | ✗ `SCHEDULE_CONFLICT` |
| `.at()` twice | ✗ `SCHEDULE_CONFLICT` |
| `.cron()` + `.mondays()` (either order) | ✗ `SCHEDULE_CONFLICT`: put the day in the expression |
| `.at('25:00')`, `.at('ab')` | ✗ `SCHEDULE_INVALID_TIME`: hour 0–23, minute 0–59 |

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

## Recover stuck work: `defineReconciler()`

If a dispatch fails **after** the business commit, or a worker dies mid-job, the entity stays in
an intermediate state (`processing`) forever. `defineReconciler` builds the safety net on the
scheduler: on a cadence it finds the stuck items and re-dispatches them.

```ts
import { defineReconciler } from '@basaltkit/scheduler'

schedulerPlugin({
  define: (schedule) => {
    defineReconciler({
      name: 'stuck-orders',
      every: '5m',                   // or a cron expression
      find: () => prisma.order.findMany({
        where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
        take: 500,
      }),
      redispatch: (order) => ProcessOrder.dispatch({ orderId: order.id }), // must be idempotent
      maxPerRun: 100,
      onError: (error, order) => logger.error({ err: error, orderId: order?.id }, 'reconcile failed'),
    }).schedule(schedule)
  },
})
```

- **No overlap** — a run never starts while the previous one is still running (the tick is
  skipped and counted in `reconciler.stats.skippedOverlaps`). With a scheduler `lock` the entry
  runs on one replica per tick; `lock: ReconcilerLock` (`acquire` + `release`) additionally holds a
  distributed mutex for the whole run.
- **Per-item isolation** — a throwing `redispatch` goes to `onError(error, item)` and the next
  item still runs; a throwing `find` goes to `onError(error, undefined)`. Default: `console.error`.
- **Observable** — every run emits the `reconciler:run` hook on the app's bus with
  `{ name, found, redispatched, failed, skipped, reason?, error?, durationMs }`; `onRun(result)`
  is the same data as a callback.
- `every` accepts whole minutes dividing 60, whole hours dividing 24, `'1d'` or a cron
  expression; anything else throws `ScheduleDefinitionError` (`SCHEDULE_INVALID_INTERVAL`) at boot.

The entry is named `reconciler:<name>`, so `basalt schedule:run reconciler:stuck-orders` runs it
on demand. The full option table is in the
[package README](https://github.com/basaltkit/basalt/tree/main/packages/scheduler#definereconcilert-options-reconcileroptionst-reconciler).

### Sweeping every tenant

A reconciler is central code: it must see stuck work in **all** tenants — exactly what tenant
scoping forbids. With Postgres RLS on, `find` cannot even run: the application role only ever sees
one tenant, and the Prisma tenancy extension refuses unscoped queries.

`@basaltkit/prisma` supplies the missing piece. `crossTenantScanSql` generates a `SECURITY
DEFINER` function that returns **identifiers only** (tenant id + row id) across every tenant,
capped and paged by the database itself; `find` calls it, and `redispatch` processes each item
back inside its own tenant:

```ts
import { crossTenantScan } from '@basaltkit/prisma'

defineReconciler({
  name: 'stuck-jobs',
  every: '5m',
  // central code — no tenant in scope; the function caps the page size itself
  find: () => crossTenantScan(db, 'stuck_jobs', { limit: 200 }),
  // back inside the item's tenant: the scoped client and the RLS policies apply again
  redispatch: (item) => tenancy.run(item.tenantId, () => ProcessJob.dispatch({ jobId: item.id })),
}).schedule(schedule)
```

`crossTenantSweep({ client, scanFunction, run, handle })` is the same thing in one call when you
want the paging and the grouping too: it walks every page and enters each tenant once per page
instead of once per item. Without RLS neither needs the SQL function — pass an ordinary central
query as `scan`.

The scan function is a **deliberate RLS bypass**, so its rules (identifiers only, `EXECUTE`
restricted to the app role, `search_path` pinned, capped cursor) are part of your security review:
see the [security guide](/guide/security#_3-automatic-tenant-scoping-covers-the-orm-—-not-raw-sql-or-foreign-key-scalars)
and the [@basaltkit/prisma README](https://github.com/basaltkit/basalt/tree/main/packages/prisma#sweeping-every-tenant-cross-tenant-scan).

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
| `ScheduleDefinitionError` (code `SCHEDULE_CONFLICT`) at boot | An entry chains two frequencies (`.daily().monthly()`), uses `.at()` after `everyMinute`/`everyMinutes`/`hourly`/`cron` or twice, or combines `.cron()` with a day-of-week modifier. Previously the last call silently won | Keep the one frequency you mean, e.g. `.monthly().at('03:00')`; for anything else use `.cron()` alone |
| `ScheduleDefinitionError` (code `SCHEDULE_INVALID_TIME`) at boot | `.at()` got something other than `HH:mm` (hour 0–23, minute 0–59) | Fix the time string, e.g. `.at('03:00')` |
| `ScheduleDefinitionError` (code `SCHEDULE_INVALID_INTERVAL`) at boot | A reconciler's `every` can't be expressed on the minute-based cron (`'30s'`, `'7m'`, `'90m'`) | Use `'1m'`, `'5m'`, `'15m'`, `'2h'`, `'1d'` or a cron expression |
| `AggregateError: Failure in N scheduled task(s)` | Tasks without `onFailure` threw during a tick; every due entry still ran and the process survived | Add `.onFailure()` to route each task's errors to your reporting |
| A task runs N times at once across pods | The entry lacks `.onOneServer()` (or replicas point at different lock stores) | Mark it `.onOneServer()`; share one lock store across replicas |
| An `.onOneServer()` task failed the tick while Redis was down | Fail closed: a lock-store failure is a task failure, never permission to run everywhere | Restore the lock store; the next minute's tick recovers |
| A task silently skipped a minute | Overlap guard or lock: check `entry.skippedOverlaps` and `scheduler.skippedByLock` counters | Expected behavior — lengthen the interval if runs routinely overlap |
| `Unknown scheduled task "x"` from `schedule:run` | The name doesn't match any entry | `basalt schedule:run` prints the available names — use one of those |

## See also

- [Queues & jobs](/guide/queues) — where `schedule.job(...)` dispatches to.
