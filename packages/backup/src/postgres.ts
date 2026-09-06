import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Logger } from '@basaltkit/logger'
import { tenantSchema } from '@basaltkit/prisma'
import type { Disk } from '@basaltkit/storage'
import { BackupCommandError, BackupConfigError, BackupNotFoundError, BackupRestoreRejectedError } from './errors.js'

export type BackupTarget =
  | { kind: 'full' }
  | { kind: 'central'; schema?: string }
  | { kind: 'tenant'; tenantId: string; schema?: string; databaseUrl?: string }

export type BackupStatus = 'running' | 'succeeded' | 'failed'

export interface BackupManifest {
  id: string
  target: BackupTarget
  mode: 'full' | 'schema' | 'database'
  artifact: string
  createdAt: string
  completedAt?: string
  status: BackupStatus
  sizeBytes?: number
  sha256?: string
  error?: string
}

export interface CommandRunner {
  (command: string, args: string[], options: { cwd: string; output?: string }): Promise<void>
}

export interface PostgresBackupOptions {
  connectionUrl: string
  disk: Disk
  prefix?: string
  pgDumpPath?: string
  pgRestorePath?: string
  tenantSchemaPrefix?: string
  tenantDatabaseUrl?: (tenantId: string) => string | Promise<string>
  retention?: number
  logger?: Logger
  runner?: CommandRunner
  clock?: () => Date
}

export interface RestoreOptions {
  confirm: () => boolean | Promise<boolean>
  environment?: string
  allowProduction?: boolean
  pgRestorePath?: string
}

export interface TenantIterator {
  forEach(
    fn: (tenant: { id: string }) => void | Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>
}

export class PostgresBackup {
  private readonly options: PostgresBackupOptions
  private readonly prefix: string
  private readonly runner: CommandRunner
  private readonly clock: () => Date

  constructor(options: PostgresBackupOptions) {
    if (!options.connectionUrl) throw new BackupConfigError('connectionUrl is required.')
    if (!options.disk) throw new BackupConfigError('disk is required.')
    this.options = options
    this.prefix = trimSlashes(options.prefix ?? 'backups')
    this.runner = options.runner ?? runCommand
    this.clock = options.clock ?? (() => new Date())
  }

  async create(target: BackupTarget): Promise<BackupManifest> {
    const id = randomUUID()
    const started = this.clock().toISOString()
    const artifact = `${this.prefix}/${id}.dump`
    const manifestKey = `${this.prefix}/${id}.json`
    const running: BackupManifest = { id, target, mode: this.modeFor(target), artifact, createdAt: started, status: 'running' }
    await this.options.disk.put(manifestKey, JSON.stringify(running), { contentType: 'application/json' })
    const folder = await mkdtemp(join(tmpdir(), 'basalt-backup-'))
    const output = join(folder, 'backup.dump')
    try {
      const resolved = await this.resolveTarget(target)
      const args = [
        '--format=custom',
        '--no-password',
        '--file',
        output,
        '--dbname',
        postgresToolUrl(resolved.url),
      ]
      if (resolved.schema) args.push('--schema', resolved.schema)
      this.options.logger?.info({ backupId: id, target }, 'backup started')
      await this.runner(this.options.pgDumpPath ?? 'pg_dump', args, { cwd: folder, output })
      const content = await readFile(output)
      const completed: BackupManifest = {
        ...running,
        status: 'succeeded',
        completedAt: this.clock().toISOString(),
        sizeBytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
      await this.options.disk.put(artifact, content, { contentType: 'application/octet-stream' })
      await this.options.disk.put(manifestKey, JSON.stringify(completed), { contentType: 'application/json' })
      this.options.logger?.info({ backupId: id, sizeBytes: content.byteLength }, 'backup completed')
      await this.prune(target)
      return completed
    } catch (error) {
      const failed: BackupManifest = { ...running, status: 'failed', completedAt: this.clock().toISOString(), error: error instanceof Error ? error.message : String(error) }
      await this.options.disk.put(manifestKey, JSON.stringify(failed), { contentType: 'application/json' })
      this.options.logger?.error({ err: error, backupId: id, target }, 'backup failed')
      throw error
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  async createAllTenants(tenancy: TenantIterator, options: { concurrency?: number; schema?: boolean } = {}): Promise<BackupManifest[]> {
    const results: BackupManifest[] = []
    await tenancy.forEach(async (tenant) => {
      const schema = options.schema === false
        ? undefined
        : tenantSchema(tenant.id, this.options.tenantSchemaPrefix ? { prefix: this.options.tenantSchemaPrefix } : {})
      results.push(await this.create({ kind: 'tenant', tenantId: tenant.id, ...(schema ? { schema } : {}) }))
    }, { ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}) })
    return results
  }

  async list(): Promise<BackupManifest[]> {
    const keys = await this.options.disk.list(`${this.prefix}/`)
    const manifests = await Promise.all(
      keys.filter((key) => key.endsWith('.json')).map(async (key) => {
        try {
          return JSON.parse((await this.options.disk.get(key)).toString()) as BackupManifest
        } catch (error) {
          // A manifest can be observed while a driver is replacing it, or be
          // left partial after a process is terminated. It must not hide the
          // healthy backups that retention and operators still need to see.
          this.options.logger?.warn({ err: error, key }, 'ignoring invalid backup manifest')
          return undefined
        }
      }),
    )
    return manifests.filter((manifest): manifest is BackupManifest => manifest !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async restore(id: string, connectionUrl: string, options: RestoreOptions): Promise<void> {
    if (options.environment === 'production' && options.allowProduction !== true) throw new BackupRestoreRejectedError('Restoring in production requires allowProduction: true.')
    if (!(await options.confirm())) throw new BackupRestoreRejectedError('Restore was not confirmed.')
    const manifest = (await this.list()).find((item) => item.id === id)
    if (!manifest || manifest.status !== 'succeeded') throw new BackupNotFoundError(id)
    const folder = await mkdtemp(join(tmpdir(), 'basalt-restore-'))
    const input = join(folder, 'backup.dump')
    try {
      await writeFile(input, await this.options.disk.get(manifest.artifact))
      await this.runner(
        options.pgRestorePath ?? this.options.pgRestorePath ?? 'pg_restore',
        [
          '--no-password',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--exit-on-error',
          '--dbname',
          postgresToolUrl(connectionUrl),
          input,
        ],
        { cwd: folder },
      )
      this.options.logger?.info({ backupId: id }, 'backup restored')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  private async prune(target: BackupTarget): Promise<void> {
    if (this.options.retention === undefined) return
    const matching = (await this.list()).filter((item) => item.status === 'succeeded' && sameTarget(item.target, target))
    for (const old of matching.slice(Math.max(0, this.options.retention))) {
      await this.options.disk.delete(old.artifact)
      await this.options.disk.delete(`${this.prefix}/${old.id}.json`)
    }
  }

  private modeFor(target: BackupTarget): 'full' | 'schema' | 'database' { return target.kind === 'tenant' && target.databaseUrl ? 'database' : target.kind === 'full' ? 'full' : 'schema' }

  private async resolveTarget(target: BackupTarget): Promise<{ url: string; schema?: string }> {
    if (target.kind === 'full') return { url: this.options.connectionUrl }
    if (target.kind === 'central') {
      return { url: this.options.connectionUrl, schema: target.schema ?? 'public' }
    }
    if (!target.tenantId) throw new BackupConfigError('tenant backups require tenantId.')
    const url = target.databaseUrl ?? await this.options.tenantDatabaseUrl?.(target.tenantId)
    if (url) return { url, ...(target.schema ? { schema: target.schema } : {}) }
    return {
      url: this.options.connectionUrl,
      schema: target.schema ?? tenantSchema(target.tenantId, this.options.tenantSchemaPrefix ? { prefix: this.options.tenantSchemaPrefix } : {}),
    }
  }
}

function sameTarget(a: BackupTarget, b: BackupTarget): boolean { return a.kind === b.kind && ('tenantId' in a ? a.tenantId === (b as typeof a).tenantId : true) }

function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}

/** Prisma uses `schema` to select search_path; PostgreSQL client tools reject it. */
function postgresToolUrl(connectionUrl: string): string {
  const url = new URL(connectionUrl)
  url.searchParams.delete('schema')
  return url.toString()
}

async function runCommand(command: string, args: string[], options: { cwd: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => reject(new BackupCommandError(command, error)))
    child.on('close', (code) => code === 0 ? resolve() : reject(new BackupCommandError(`${command} ${args.join(' ')}`, new Error(stderr.trim()))))
  })
}
