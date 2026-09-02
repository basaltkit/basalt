# Driver packages

Four of Basalt's capability modules — **queue**, **storage**, **cache** and
**mailer** — moved their heavy backends into separate packages. If you are
upgrading across those majors, everything you need is on this page.

If you are starting fresh, you can read this as one idea rather than four
migrations: **a core defines the contract, a backend is a package.**

[[toc]]

## The one-line summary

| Core | Was forced on everyone | Now |
| --- | --- | --- |
| `@basaltkit/queue` **2.x** | `bullmq` | `@basaltkit/queue-bullmq` |
| `@basaltkit/storage` **2.x** | `@aws-sdk/client-s3` + presigner — **4.4 MB** | `@basaltkit/storage-s3` |
| `@basaltkit/cache` **2.x** | `ioredis` — **1.5 MB** | `@basaltkit/cache-redis` |
| `@basaltkit/mailer` **2.x** | `nodemailer` — **688 KB** | `@basaltkit/mailer-smtp` |

You still install the core. It is not one of the backends — it is the contract
they implement, and the package your own code imports. A backend package
**depends on** the core; it never replaces it.

## Why they were coupled in the first place

Each core offered a **string shorthand** for one backend, baked into its options:

```ts
queuePlugin({ connection: REDIS_URL })            // → BullMQ
storagePlugin({ disks: { d: { driver: 's3' } } }) // → AWS SDK
cachePlugin({ driver: 'redis', url })             // → ioredis
mailerPlugin({ driver: 'smtp', smtp: { url } })   // → nodemailer
```

A string cannot be resolved lazily. For the core to turn `'s3'` into a driver it
must already have imported the AWS SDK — so **the shorthand is what forced the
dependency**. Every consumer paid for it, including the ones using a different
backend entirely: an app on Azure Blob still installed 4.4 MB of AWS SDK, and an
app sending mail through Resend still installed an SMTP client it never opened.

The satellites that already existed made it plainer. `@basaltkit/queue-rabbitmq`,
`storage-azure`, `storage-gcs` and `cache-tiered` all took a driver *instance*.
One backend per core was privileged; the rest were second-class.

## Migrating

Each is one import and one line. Nothing about your jobs, disks, cache keys or
mail definitions changes.

### Queue

```bash
pnpm add @basaltkit/queue-bullmq bullmq
```

```diff
+import { bullmqQueuePlugin } from '@basaltkit/queue-bullmq'

-queuePlugin({ connection: process.env.REDIS_URL, jobs, workers })
+bullmqQueuePlugin({ connection: process.env.REDIS_URL!, jobs, workers })
```

Every backend now ships an equivalent plugin — `rabbitmqQueuePlugin`,
`sqsQueuePlugin`, `kafkaQueuePlugin` — so swapping backend is swapping that
import. See [Queues & jobs](/guide/queues).

### Storage

```bash
pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```diff
+import { s3Disk } from '@basaltkit/storage-s3'

 storagePlugin({
   disks: {
     uploads: { driver: 'local', root: './storage' },
-    docs: { driver: 's3', bucket: 'my-app', region: 'eu-west-1' },
+    docs: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }),
   },
 })
```

`driver: 'local'` stays — it needs no client library, only `fs`. See
[Storage](/guide/storage).

### Cache

```bash
pnpm add @basaltkit/cache-redis ioredis
```

```diff
+import { redisCache } from '@basaltkit/cache-redis'

-cachePlugin({ driver: 'redis', url: process.env.REDIS_URL })
+cachePlugin({ driver: redisCache(process.env.REDIS_URL!) })
```

The default in-memory driver stays in the core. See [Caching](/guide/caching).

### Mailer

```bash
pnpm add @basaltkit/mailer-smtp nodemailer
```

```diff
+import { smtpMailer } from '@basaltkit/mailer-smtp'

-mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from })
+mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }), from })
```

`log`, `memory`, `resend`, `ses` and `mailgun` stay in the core — they are HTTP
APIs or local sinks, and need no client library. See
[Notifications](/guide/notifications).

## Am I affected?

Only if you used one of the four shorthands. You are **not** affected if you:

- passed a driver instance already (`storage-azure`, `storage-gcs`,
  `queue-rabbitmq`, `cache-tiered`, or your own);
- used `driver: 'local'`, the default in-memory cache, or the `log`/`memory`
  mailer drivers;
- never configured that capability at all.

TypeScript flags every case at compile time, because the removed strings left
their unions. `mailerPlugin({ driver: 'smtp' })` also throws at runtime with the
migration instruction, for callers coming from JavaScript or an untyped config
file.

## What you get back

An app that uses the local storage driver, the in-memory cache and Resend for
mail no longer installs the AWS SDK, ioredis or nodemailer. That is **6.5 MB** of
client libraries it never called.

It also removes an inconsistency that had become hard to defend: adding a fifth
queue backend was easy, but adding a second *first-class* one was not, because
the core had a favourite. Now no backend is privileged, and a driver of your own
plugs in exactly where the built-in ones do.

::: tip A rule you can rely on
A capability core depends on `@basaltkit/core` and nothing else. If you find one
that ships a backend client, that is a bug — a repo-wide test enforces it, and
its allowlist is empty.
:::
