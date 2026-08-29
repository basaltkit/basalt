---
'@basaltkit/queue': minor
---

`queuePlugin` accepts `onError` and `onJobFailed` and forwards them to the BullMQ driver it builds from `connection`.

The crash-safety and failure-visibility hooks added in 1.3.0 lived only on `BullmqDriverOptions`, and `queuePlugin({ connection })` constructed the driver with the connection **and nothing else** — `QueuePluginOptions` did not even accept the callbacks. On the documented shorthand path the work was therefore unreachable: the only way to route a Redis outage or a permanently-failed job to your logger was to hand-build the driver and pass it as `driver`.

Both callbacks are now plugin options:

```ts
queuePlugin({
  connection: process.env.REDIS_URL!,
  jobs,
  workers,
  onError: (error, { queue, source }) => log.error({ queue, source, error }, 'queue infra error'),
  onJobFailed: ({ queue, job, jobId, error }) => alertDeadJob(queue, job, jobId, error),
})
```

They are forwarded only to the driver built from `connection`, and are ignored when you supply your own `driver` — that driver owns its callbacks. Defaults are unchanged (a contextual `console.error`), so nothing behaves differently unless you pass a callback.
