# Scheduled tasks

[`@basaltkit/scheduler`](/reference/packages/scheduler) runs work **on a schedule** —
nightly backups, weekly reports, monthly billing — declared in readable code instead
of raw cron. The scheduler wakes once a minute, checks what's due, and runs it.

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
`shutdown`. `daily`/`weekly`/`monthly` combine with `at('HH:mm')`; `weekly` runs on
Sunday, `monthly` on the 1st. Inspect the registry with `app.container.get(SCHEDULER).list()`.

## Timezones, overlap & failures

Real schedules need more than a time — the module handles the sharp edges:

```ts
schedule.call('digest', sendDigest)
  .daily().at('07:00').timezone('Europe/Lisbon')  // local time, not the server's
  .withoutOverlapping()                            // skip if the last run is still going
  .onFailure((err) => report(err))                 // per-task error handler
```

Without `onFailure`, errors are aggregated without crashing the process. Need raw
cron? `schedule.call('x', fn).cron('*/5 * * * *')` is the escape hatch.

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
