import { createToken, definePlugin, ensureMetadata, type Container } from '@basaltkit/core'
import { SCHEDULER, type Scheduler } from '@basaltkit/scheduler'
import { STORAGE, type Disk } from '@basaltkit/storage'
import { TENANCY, type Tenancy } from '@basaltkit/tenancy'
import { PostgresBackup, type BackupTarget, type PostgresBackupOptions, type TenantIterator } from './postgres.js'

export * from './errors.js'
export * from './postgres.js'

export const BACKUP = createToken<PostgresBackup>('backup')

export interface BackupScheduleOptions {
  name?: string
  target: BackupTarget | Array<BackupTarget | 'all-tenants'> | 'all-tenants'
  cron?: string
  timezone?: string
  concurrency?: number
}

export interface BackupPluginOptions extends Omit<PostgresBackupOptions, 'disk'> {
  disk: Disk | string
  schedule?: BackupScheduleOptions
  /** Resolves the tenancy service for the all-tenants schedule. */
  tenancy?: TenantIterator
}

/** Registers PostgreSQL backup storage, CLI commands and an optional schedule. */
export function backupPlugin(options: BackupPluginOptions) {
  return definePlugin({
    name: 'basalt:backup',
    ...(options.schedule ? { dependsOn: ['basalt:scheduler'] } : {}),
    register({ container }) {
      container.singleton(BACKUP, () => new PostgresBackup({
        ...options,
        disk: typeof options.disk === 'string' ? container.get(STORAGE).disk(options.disk) : options.disk,
      }))
      registerCommands(container)
    },
    boot({ container }) {
      if (!options.schedule) return
      const scheduler = findScheduler(container)
      const backup = container.get(BACKUP)
      const schedule = scheduler.call(options.schedule.name ?? 'backup:postgres', async () => {
        const targets = Array.isArray(options.schedule!.target)
          ? options.schedule!.target
          : [options.schedule!.target]
        for (const target of targets) {
          if (target === 'all-tenants') {
            const tenancy = options.tenancy ?? container.get(TENANCY)
            await backup.createAllTenants(tenancy, {
              ...(options.schedule!.concurrency !== undefined ? { concurrency: options.schedule!.concurrency } : {}),
            })
          } else {
            await backup.create(target)
          }
        }
      })
      if (options.schedule.cron) schedule.cron(options.schedule.cron)
      else schedule.daily().at('03:00')
      if (options.schedule.timezone) schedule.timezone(options.schedule.timezone)
      schedule.withoutOverlapping()
    },
  })
}

function findScheduler(container: Container): Scheduler {
  try {
    return container.get(SCHEDULER)
  } catch {
    throw new Error('backupPlugin: register schedulerPlugin before backupPlugin.')
  }
}

function registerCommands(container: Container): void {
  const metadata = ensureMetadata(container)
  metadata.add('commands', {
    name: 'backup:list',
    description: 'List PostgreSQL backups',
    async handle({ io }: { io: { table(rows: Record<string, unknown>[]): void } }) {
      const rows = (await container.get(BACKUP).list()).map((backup) => ({
        id: backup.id,
        status: backup.status,
        target: backup.target.kind,
        createdAt: backup.createdAt,
        sizeBytes: backup.sizeBytes ?? 0,
      }))
      io.table(rows)
    },
  })
}