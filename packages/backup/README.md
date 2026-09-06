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

`create()` returns a `BackupManifest` with the backup id, target, status,
artifact path, size, timestamps and SHA-256 checksum. A successful run has
`status: 'succeeded'`; a failed PostgreSQL or storage operation writes a
`status: 'failed'` manifest and rethrows the error.

## List backups

Use `list()` to inspect manifests stored on the configured disk. Results are
sorted newest first and incomplete JSON manifests are ignored with a warning:

```ts
const backups = await service.list()

for (const item of backups) {
  console.log({
    id: item.id,
    status: item.status,
    target: item.target,
    sizeBytes: item.sizeBytes,
    createdAt: item.createdAt,
    artifact: item.artifact,
  })
}

const latestFull = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
```

The same information is available through the CLI when `backupPlugin` is
registered:

```bash
pnpm basalt backup:list
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

## Restore a backup

Restore by passing the manifest id, a destination PostgreSQL URL and an
explicit confirmation callback. The package downloads the dump to a temporary
file, runs `pg_restore`, and removes the temporary file afterwards:

```ts
const backups = await service.list()
const candidate = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
if (!candidate) throw new Error('No successful full backup available')

await service.restore(candidate.id, process.env.RESTORE_DATABASE_URL!, {
  confirm: async () => process.env.CONFIRM_RESTORE === 'yes',
  environment: process.env.NODE_ENV,
})
```

`restore()` uses `--clean --if-exists --no-owner --exit-on-error`. It refuses
production unless `allowProduction: true` is passed, and rejects a confirmation
callback that returns `false`. Restore into a disposable database first; the
destination may be different from the source database.

There is no public `prune()` method. Retention is deliberate and automatic:
set `retention` to the number of newest successful backups to keep **per
target**. After each successful `create()`, older dump and manifest pairs for
that same target are deleted:

```ts
const service = new PostgresBackup({
  connectionUrl: process.env.DATABASE_URL!,
  disk,
  retention: 7, // keep seven full, seven central and seven per-tenant backups
})
```

Failed backups are not counted as retained successful backups. Leave
`retention` undefined to disable automatic cleanup and keep all manifests and
artifacts.

`backup:list` is registered for `pnpm basalt backup:list`.

## Docker or remote PostgreSQL

Use the default runner when PostgreSQL client tools are installed in the app
runtime. If the tools live in a container, inject a runner in the application.
The package passes the command, its argument list, a working directory and,
for `pg_dump`, the host path where the binary output must be written.

```ts
import { createWriteStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const container = 'postgres'

const dockerRunner = async (command, args, options) => {
  // pg_dump writes a custom-format binary. The temporary host path cannot be
  // passed to a container, so remove --file and stream stdout to that path.
  if (command === 'pg_dump' && options.output) {
    const dumpArgs = args.filter((arg, index) =>
      arg !== '--file' && args[index - 1] !== '--file',
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['exec', container, command, ...dumpArgs], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = createWriteStream(options.output)
      let error = ''
      child.stdout.pipe(output)
      child.stderr.on('data', (chunk) => { error += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(error.trim())),
      )
    })
    return
  }

  // pg_restore receives a host temporary path. Copy it into the container
  // before running the restore, then remove the temporary container file.
  const input = args.at(-1)
  if (command === 'pg_restore' && input) {
    const remoteInput = `/tmp/basalt-${Date.now()}.dump`
    await execFileAsync('docker', ['cp', input, `${container}:${remoteInput}`])
    try {
      const restoreArgs = [...args.slice(0, -1), remoteInput]
      await execFileAsync('docker', ['exec', container, command, ...restoreArgs])
    } finally {
      await execFileAsync('docker', ['exec', container, 'rm', '-f', remoteInput])
    }
    return
  }

  await execFileAsync('docker', ['exec', container, command, ...args], {
    cwd: options.cwd,
  })
}

const backup = new PostgresBackup({
  connectionUrl: process.env.DATABASE_URL!,
  disk,
  runner: dockerRunner,
})
```

The database URL must be reachable from inside the container. A URL such as
`localhost:5433` from the host may need to become `localhost:5432` inside the
PostgreSQL container. Remove Prisma's `schema` query parameter only if your
custom runner constructs the command itself; `PostgresBackup` already removes it
before calling the PostgreSQL client tools.

This keeps deployment-specific process details out of the reusable package.

## Options reference

### `PostgresBackupOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `connectionUrl` | `string` | required | PostgreSQL connection URL. |
| `disk` | `Disk` | required | Destination for dumps and manifests. |
| `prefix` | `string` | `backups` | Artifact prefix, normalized without outer `/`. |
| `pgDumpPath` | `string` | `pg_dump` | PostgreSQL dump executable. |
| `pgRestorePath` | `string` | `pg_restore` | PostgreSQL restore executable. |
| `tenantSchemaPrefix` | `string` | `tenant_` | Prefix used to derive schema-per-tenant names. |
| `tenantDatabaseUrl` | `(tenantId) => string \| Promise<string>` | none | Resolves database-per-tenant URLs. |
| `retention` | `number` | none | Number of newest successful backups kept per target. |
| `runner` | `CommandRunner` | local subprocess | Executes `pg_dump` and `pg_restore`; use this for Docker/Kubernetes. |
| `logger` | `Logger` | none | Receives start, success, failure and invalid-manifest logs. |

### `CommandRunner`

| Parameter | Type | Description |
| --- | --- | --- |
| `command` | `string` | Usually `pg_dump` or `pg_restore`. |
| `args` | `string[]` | Argument list; never concatenate into a shell command. |
| `options.cwd` | `string` | Temporary working directory for this operation. |
| `options.output` | `string \| undefined` | Host path for `pg_dump` binary output. Required by streaming Docker runners. |

### `BackupTarget`

| Target | Required fields | Result |
| --- | --- | --- |
| `full` | `kind: 'full'` | Complete database dump. |
| `central` | `kind: 'central'`, optional `schema` | Central schema dump; defaults to `public`. |
| `tenant` schema | `kind: 'tenant'`, `tenantId`, optional `schema` | Individual schema dump. |
| `tenant` database | `kind: 'tenant'`, `tenantId`, `databaseUrl` | Individual database dump. |