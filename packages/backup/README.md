# @basaltkit/backup

PostgreSQL backups for Basalt applications. The package runs the PostgreSQL
client tools, writes immutable dump artifacts and JSON manifests to a Basalt
`Disk`, and keeps execution independent from Prisma's query API.

## Install

```sh
pnpm add @basaltkit/backup
```

The host running the application needs `pg_dump` and `pg_restore`, or the app
can provide a `runner` that invokes them through Docker, Kubernetes, a sidecar,
or another process boundary. The package never assumes where PostgreSQL runs.

## Basic setup

```ts
import { BACKUP, backupPlugin } from '@basaltkit/backup'
import { createApp } from '@basaltkit/core'
import { storagePlugin } from '@basaltkit/storage'

const app = await createApp({
  plugins: [
    storagePlugin({
      disks: {
        backups: { driver: 'local', root: './backups', scope: null },
      },
    }),
    backupPlugin({
      connectionUrl: process.env.DATABASE_URL!,
      disk: 'backups',
      retention: 7,
    }),
  ],
}).boot()

const service = app.container.get(BACKUP)
await service.create({ kind: 'full' })
await service.create({ kind: 'central' }) // public schema
await service.create({ kind: 'tenant', tenantId: 'acme' })
```

The `Disk` can be local or supplied by `@basaltkit/storage-s3`, which covers
AWS S3, MinIO, R2 and other S3-compatible services. Backup disks should use
`scope: null`: the backup service applies its own target and manifest paths.

## Where backup files are stored

The backup package does not require S3 or MinIO. The destination is determined
entirely by the `Disk` supplied by the application:

- **Local filesystem:** configure a local disk such as
  `{ driver: 'local', root: './backups', scope: null }`. Dump and manifest files
  are written below that directory.
- **S3-compatible storage:** configure a disk with `s3Disk(...)`. This works
  with AWS S3, MinIO, Cloudflare R2 and other compatible services.

For applications with separate document and backup settings, an S3 endpoint for
documents does not automatically make backups use S3. Backups use S3 only when
the backup disk itself is configured with an S3 driver. Otherwise they remain
local.

The default artifact prefix is `backups/`. On a local disk this means paths
such as `./backups/backups/<id>.dump` when the disk root is `./backups`. In an
S3 bucket, it means keys such as `backups/<id>.dump` and
`backups/<id>.json`.

Example local configuration:

```ts
storagePlugin({
  disks: {
    backups: { driver: 'local', root: './storage/backups', scope: null },
  },
})
```

Example S3/MinIO configuration:

```ts
storagePlugin({
  disks: {
    backups: s3Disk({
      bucket: process.env.BACKUP_BUCKET!,
      endpoint: process.env.S3_ENDPOINT, // omit for AWS S3
      region: process.env.S3_REGION ?? 'us-east-1',
      scope: null,
    }),
  },
})
```

When changing the destination through environment variables, restart the
application. Configuration is read during boot; an already-running scheduler
continues using the disk selected at startup.

## Multi-tenant modes

- `full` dumps the complete database, including all schemas.
- `central` dumps one central schema, `public` by default.
- `tenant` dumps a PostgreSQL schema derived with `@basaltkit/prisma`'s
  `tenantSchema()` helper. Pass `databaseUrl` or `tenantDatabaseUrl` for
  database-per-tenant deployments.
- `createAllTenants(tenancy)` iterates through `@basaltkit/tenancy` with bounded
  concurrency and creates one manifest per tenant.

## Scheduling and restore

`backupPlugin` registers an entry in the existing `@basaltkit/scheduler`
instance. It does not start a second timer or cron process. Pass `schedule` for
a daily task, or provide `cron` and `timezone`; it uses
`withoutOverlapping()`. For applications that already declare all tasks in
`schedulerPlugin({ define })`, instantiate `PostgresBackup` in that callback
and call `create()` or `createAllTenants()` from the existing schedule.

The package does not import or resolve `@basaltkit/tenancy`. For an
`'all-tenants'` schedule, pass the application's tenant iterator explicitly:

```ts
backupPlugin({
  connectionUrl,
  disk: 'backups',
  tenancy: app.container.get(TENANCY),
  schedule: {
    target: 'all-tenants',
    cron: '0 3 * * *',
  },
})
```

This keeps tenancy opt-in while retaining schema-per-tenant and
database-per-tenant backups through the structural `TenantIterator` contract.

Failures are represented in the manifest and logger output. `restore()` requires
an explicit confirmation callback and refuses production unless
`allowProduction: true` is provided.

`backup:list` is registered for `pnpm basalt backup:list`.

## Docker or remote PostgreSQL

Use the default runner when PostgreSQL client tools are installed in the app
runtime. If the tools live in a container, inject a runner in the application:

```ts
runner: (command, args, options) => runDockerDump(command, args, options)
```

This keeps deployment-specific process details out of the reusable package.