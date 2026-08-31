# @basaltkit/queue-bullmq

## 1.0.0

### Major Changes

- 4586ff4: **New package: the BullMQ/Redis driver and plugin for `@basaltkit/queue`**,
  extracted from the core so that no backend is privileged in the core's API.
  
  ```bash
  pnpm add @basaltkit/queue @basaltkit/queue-bullmq bullmq
  ```
  
  ```ts
  import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'
  
  bullmqQueuePlugin({
    connection: process.env.REDIS_URL!,
    jobs: [SendWelcome],
    workers: [{ queue: 'welcome', concurrency: 5 }],
  })
  ```
  
  Exports `bullmqQueuePlugin`, `BullmqQueueDriver` and `BullmqDriverOptions`. The
  plugin accepts every `queuePlugin` option (`jobs`, `workers`, `onUnsupported`,
  `removeOnComplete`, `removeOnFail`) alongside the driver's own `connection`,
  `onError` and `onJobFailed`.
  
  The driver code is unchanged from `@basaltkit/queue@2.0.0` — this is a move, not
  a rewrite, and its tests moved with it. `bullmq` is a **required** peer
  dependency here, which is what licenses this package (unlike the core) to import
  it statically.
  
  Coming from `queuePlugin({ connection })`? See the `@basaltkit/queue` entry in
  this release for the migration.

### Patch Changes

- Updated dependencies [4586ff4]
  - @basaltkit/queue@2.1.0
