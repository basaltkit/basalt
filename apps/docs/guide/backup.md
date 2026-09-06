# PostgreSQL backups

`@basaltkit/backup` provides PostgreSQL backups for Basalt applications without
coupling the framework to a particular deployment. It runs `pg_dump` and
`pg_restore`, stores dump artifacts and JSON manifests through a Basalt `Disk`,
and works with local storage, S3, MinIO and other S3-compatible services.

[[toc]]

## Install

```bash
pnpm add @basaltkit/backup @basaltkit/storage
```

The application runtime must provide `pg_dump` and `pg_restore`, or configure a
custom `runner`. PostgreSQL may run locally, in Docker, in Kubernetes or on a
managed provider. The package does not assume where the database runs.

## Configure storage

Use a dedicated disk with `scope: null`. A backup contains application-wide
data and must not inherit the request tenant prefix:

```ts
import { storagePlugin } from '@basaltkit/storage'

storagePlugin({
  disks: {
    backups: { driver: 'local', root: './backups', scope: null },
  },
})
```

For MinIO, AWS S3, R2 or another S3-compatible service, use
`@basaltkit/storage-s3` and pass `scope: null` to `s3Disk`.

## Where files go

S3/MinIO is optional. The backup destination is selected by the backup `Disk`,
not by `@basaltkit/backup` itself:

- A local disk writes dumps and manifests to its configured filesystem root.
- An S3-compatible disk writes them to the configured bucket.
- Configuring S3 for application documents does not automatically configure S3
  for backups. The backup disk must explicitly use `s3Disk(...)`.

The default artifact prefix is `backups/`. For example, an S3 bucket contains
keys like:

```text
backups/32288d74-e732-4657-a685-1c77193adab3.dump
backups/32288d74-e732-4657-a685-1c77193adab3.json
```

With a local disk rooted at `./backups`, the same prefix produces paths below
`./backups/backups/`. Choose a different disk root if you want the files
directly under a single `./backups` directory.

In the OfficeLaw demo, `BACKUP_BUCKET` controls this choice: when it is empty,
the backup disk is local; when it is set together with `S3_ENDPOINT`, the disk
uses S3/MinIO. The bucket is created by the demo bootstrap when necessary.
Restart the application after changing these variables because the disk is
selected during boot.

To inspect an S3-compatible destination, list the configured bucket and look
for the `backups/` prefix. To inspect a local destination, list the configured
disk root from the same working directory used to start the application.

## Create backups

Register the plugin with the database URL and disk name:

```ts
import { BACKUP, backupPlugin } from '@basaltkit/backup'

backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  retention: 7,
})

const backup = app.container.get(BACKUP)
await backup.create({ kind: 'full' })
await backup.create({ kind: 'central' })
```

Each run writes a custom-format dump and a JSON manifest containing status,
target, timestamps, size and SHA-256 checksum. Failed runs remain visible as
`failed` manifests and are logged with the backup id.

## List and inspect backups

`list()` reads the JSON manifests from the configured disk, returns them newest
first, and ignores incomplete manifests with a warning:

```ts
const backups = await backup.list()

for (const item of backups) {
  console.log(item.id, item.status, item.target, item.sizeBytes, item.artifact)
}

const latestFull = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
```

Each `BackupManifest` includes `id`, `target`, `mode`, `artifact`,
`createdAt`, `completedAt`, `status`, `sizeBytes`, `sha256` and, for failures,
`error`. The CLI equivalent is:

```bash
pnpm basalt backup:list
```

## Multi-tenant targets

| Target | Behavior |
| --- | --- |
| `{ kind: 'full' }` | Dumps the complete PostgreSQL database. |
| `{ kind: 'central' }` | Dumps the `public` schema by default; pass `schema` for another central schema. |
| `{ kind: 'tenant', tenantId }` | Dumps the tenant schema derived by `tenantSchema()`. |
| `{ kind: 'tenant', tenantId, databaseUrl }` | Dumps a database-per-tenant connection. |

For schema-per-tenant applications, iterate through the existing tenancy
service. The iteration is bounded and each tenant receives an independent
manifest:

```ts
await backup.createAllTenants(app.container.get(TENANCY), { concurrency: 5 })
```

`@basaltkit/backup` does not depend on `@basaltkit/tenancy`. The application
passes the iterator as configuration when scheduling all tenants:

```ts
backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  tenancy: app.container.get(TENANCY),
  schedule: {
    target: 'all-tenants',
    cron: '0 3 * * *',
  },
})
```

The iterator is a structural callback contract, so applications can provide
their own tenant registry without installing the Basalt tenancy package.

For database-per-tenant deployments, configure `tenantDatabaseUrl` or pass a
`databaseUrl` for each target. A full database dump is not a safe substitute
for a tenant-by-tenant export when isolation is required.

## Use the existing scheduler

The backup plugin adds a task to the `Scheduler` already registered by
`schedulerPlugin`; it does not create another cron process:

```ts
import { backupPlugin } from '@basaltkit/backup'
import { schedulerPlugin } from '@basaltkit/scheduler'

schedulerPlugin({ autostart: true })
backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  schedule: {
    name: 'backup:postgres',
    target: [{ kind: 'full' }, { kind: 'central' }, 'all-tenants'],
    cron: '0 3 * * *',
    timezone: 'UTC',
  },
})
```

The entry uses `withoutOverlapping()`. Run it manually with the normal
scheduler command:

```bash
pnpm basalt schedule:run backup:postgres
```

Applications that centralize task declarations in `schedulerPlugin({ define })`
can call `PostgresBackup.create()` from that callback instead. Both approaches
use the same scheduler instance.

## Docker and remote PostgreSQL

The default runner invokes `pg_dump` from the application runtime. If the
client binary is in a container, provide an application-specific runner. The
important detail is that custom-format dumps are binary: remove the host-only
`--file` argument and stream `docker exec` stdout to `options.output`.

```ts
import { createWriteStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { PostgresBackup } from '@basaltkit/backup'

const execFileAsync = promisify(execFile)
const container = process.env.POSTGRES_CONTAINER ?? 'postgres'

const dockerRunner = async (command, args, options) => {
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
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(error.trim())))
    })
    return
  }

  // pg_restore receives a host temporary path; copy it into the container.
  const input = args.at(-1)
  if (command === 'pg_restore' && input) {
    const remoteInput = `/tmp/basalt-${Date.now()}.dump`
    await execFileAsync('docker', ['cp', input, `${container}:${remoteInput}`])
    try {
      await execFileAsync('docker', [
        'exec', container, command, ...args.slice(0, -1), remoteInput,
      ])
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
  disk: app.container.get(STORAGE).disk('backups'),
  runner: dockerRunner,
})
```

The database URL must be reachable from inside the container. For example,
`localhost:5433` on the host may be `localhost:5432` inside the PostgreSQL
container. `PostgresBackup` removes Prisma's `schema` URL parameter before
calling the PostgreSQL tools. Keep container names, Kubernetes pod names and
credentials outside the reusable package.

### Runner parameters

| Parameter | Type | Meaning |
| --- | --- | --- |
| `command` | `string` | `pg_dump` or `pg_restore`. |
| `args` | `string[]` | Argument list passed to the tool; do not build a shell string. |
| `options.cwd` | `string` | Temporary working directory on the application host. |
| `options.output` | `string \| undefined` | Host path where a Docker `pg_dump` runner must write binary stdout. |

### Backup options

| Option | Default | Meaning |
| --- | --- | --- |
| `connectionUrl` | required | PostgreSQL URL. |
| `disk` | required | Local or S3-compatible destination disk. |
| `prefix` | `backups` | Prefix for dump and manifest keys. |
| `pgDumpPath` / `pgRestorePath` | `pg_dump` / `pg_restore` | Tool names or paths. |
| `tenantSchemaPrefix` | `tenant_` | Schema-per-tenant name prefix. |
| `tenantDatabaseUrl` | none | Callback resolving database-per-tenant URLs. |
| `retention` | none | Newest successful backups kept per target. |
| `runner` | local subprocess | Custom Docker, Kubernetes or sidecar execution. |
| `logger` | none | Logger for lifecycle and failure messages. |

## Retention and restore

There is no public `prune()` method. Set `retention` to keep the newest
successful backups for each target. Cleanup runs automatically at the end of
each successful `create()` and deletes the older artifact and manifest pair:

```ts
const backup = new PostgresBackup({
  connectionUrl: process.env.DATABASE_URL!,
  disk,
  retention: 7,
})
```

This keeps seven full backups, seven central backups and seven backups for each
tenant target independently. Failed runs do not consume the retention count.
Leave `retention` undefined to disable cleanup.

Restoration is explicit and guarded:

```ts
const backups = await backup.list()
const candidate = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
if (!candidate) throw new Error('No successful full backup available')

await backup.restore(candidate.id, process.env.RESTORE_DATABASE_URL!, {
  confirm: async () => process.env.CONFIRM_RESTORE === 'yes',
  environment: process.env.NODE_ENV,
})
```

`restore()` downloads the artifact to a temporary file, invokes `pg_restore`
with `--clean --if-exists --no-owner --exit-on-error`, and removes the file.
Production restoration requires `allowProduction: true`; a false confirmation
is rejected. Always restore into a disposable database first and verify the
resulting application before replacing the live database.

## CLI

When `backupPlugin` is registered, `backup:list` is available to the Basalt CLI:

```bash
pnpm basalt backup:list
```

The regular scheduler commands remain the way to trigger scheduled backups;
manual application workflows can call `BACKUP.create()` directly.