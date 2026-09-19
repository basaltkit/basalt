import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Logger } from '@basaltkit/logger'
import { tenantSchema } from '@basaltkit/prisma'
import type { Disk } from '@basaltkit/storage'
import { BackupCommandError, BackupConfigError, BackupIntegrityError, BackupNotFoundError, BackupRestoreRejectedError } from './errors.js'

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
  /**
   * Runs a PostgreSQL client tool. The connection URL in `args` never carries
   * a password; when one is configured it is supplied in `env.PGPASSWORD`,
   * which a custom runner must forward to the child process environment.
   */
  (command: string, args: string[], options: { cwd: string; output?: string; env?: Record<string, string> }): Promise<void>
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
    const running: BackupManifest = { id, target: redactTarget(target), mode: this.modeFor(target), artifact, createdAt: started, status: 'running' }
    await this.options.disk.put(manifestKey, JSON.stringify(running), { contentType: 'application/json' })
    const folder = await mkdtemp(join(tmpdir(), 'basalt-backup-'))
    const output = join(folder, 'backup.dump')
    const secrets = [...connectionSecrets(this.options.connectionUrl), ...(target.kind === 'tenant' && target.databaseUrl ? connectionSecrets(target.databaseUrl) : [])]
    try {
      const resolved = await this.resolveTarget(target)
      const tool = postgresToolConnection(resolved.url)
      secrets.push(...tool.secrets)
      const args = [
        '--format=custom',
        '--no-password',
        '--file',
        output,
        '--dbname',
        tool.url,
      ]
      if (resolved.schema) args.push('--schema', resolved.schema)
      this.options.logger?.info({ backupId: id, target: running.target }, 'backup started')
      await this.runner(this.options.pgDumpPath ?? 'pg_dump', args, { cwd: folder, output, ...(tool.env ? { env: tool.env } : {}) })
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
    } catch (caught) {
      const error = scrubError(caught, secrets)
      const failed: BackupManifest = { ...running, status: 'failed', completedAt: this.clock().toISOString(), error: scrubSecrets(error instanceof Error ? error.message : String(error), secrets) }
      await this.options.disk.put(manifestKey, JSON.stringify(failed), { contentType: 'application/json' })
      this.options.logger?.error({ err: error, backupId: id, target: running.target }, 'backup failed')
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
    // The manifest lives on the same storage as the artifact, so only trust
    // the canonical artifact key for this id and the checksum recorded at
    // creation time; anything else is refused before pg_restore runs.
    if (manifest.artifact !== `${this.prefix}/${id}.dump`) throw new BackupIntegrityError(id, 'artifact path does not match the backup id.')
    if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new BackupIntegrityError(id, 'no checksum was recorded.')
    const content = await this.options.disk.get(manifest.artifact)
    const actual = createHash('sha256').update(content).digest()
    const expected = Buffer.from(manifest.sha256, 'hex')
    if (!timingSafeEqual(actual, expected)) throw new BackupIntegrityError(id, 'artifact checksum mismatch.')
    const tool = postgresToolConnection(connectionUrl)
    const folder = await mkdtemp(join(tmpdir(), 'basalt-restore-'))
    const input = join(folder, 'backup.dump')
    try {
      await writeFile(input, content)
      await this.runner(
        options.pgRestorePath ?? this.options.pgRestorePath ?? 'pg_restore',
        [
          '--no-password',
          '--clean',
          '--if-exists',
          '--no-owner',
          '--exit-on-error',
          '--dbname',
          tool.url,
          input,
        ],
        { cwd: folder, ...(tool.env ? { env: tool.env } : {}) },
      )
      this.options.logger?.info({ backupId: id }, 'backup restored')
    } catch (error) {
      throw scrubError(error, tool.secrets)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  private async prune(target: BackupTarget): Promise<void> {
    if (this.options.retention === undefined) return
    const matching = (await this.list()).filter((item) => item.status === 'succeeded' && sameTarget(item.target, target))
    for (const old of matching.slice(Math.max(0, this.options.retention))) {
      // Only ever delete the canonical artifact key, never a path read from a
      // (possibly tampered) manifest.
      await this.options.disk.delete(`${this.prefix}/${old.id}.dump`)
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

const PASSWORD_PARAMS = ['password', 'sslpassword']

function parseConnectionUrl(connectionUrl: string): URL {
  try {
    return new URL(connectionUrl)
  } catch {
    // Node's ERR_INVALID_URL carries the raw input, credentials included.
    throw new BackupConfigError('The PostgreSQL connection URL is invalid.')
  }
}

/**
 * Prisma uses `schema` to select search_path; PostgreSQL client tools reject it.
 * Passwords are moved out of the URL (which ends up on argv, visible in the
 * process list and in error messages) into the child environment.
 */
function postgresToolConnection(connectionUrl: string): { url: string; env?: Record<string, string>; secrets: string[] } {
  const url = parseConnectionUrl(connectionUrl)
  url.searchParams.delete('schema')
  const secrets = connectionSecrets(connectionUrl)
  const env: Record<string, string> = {}
  if (url.password) env.PGPASSWORD = safeDecode(url.password)
  else if (url.searchParams.get('password')) env.PGPASSWORD = url.searchParams.get('password')!
  url.password = ''
  // libpq has no environment variable for `sslpassword`, so it stays in the
  // URL; it is still redacted from manifests, logs and error messages.
  url.searchParams.delete('password')
  return { url: url.toString(), ...(Object.keys(env).length > 0 ? { env } : {}), secrets }
}

function connectionSecrets(connectionUrl: string): string[] {
  let url: URL
  try { url = new URL(connectionUrl) } catch { return [] }
  const values = [url.password, safeDecode(url.password), ...PASSWORD_PARAMS.flatMap((param) => url.searchParams.getAll(param))]
  return [...new Set(values.filter((value) => value.length > 0))]
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Replaces the userinfo password of any URL and every known secret in `text`. */
function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let result = text.replace(/(:\/\/[^\s:@/]*):[^\s@/]*@/g, '$1:***@')
    .replace(/((?:^|[\s?&])(?:ssl)?password=)[^\s&]*/gi, '$1***')
  for (const secret of secrets) result = result.split(secret).join('***')
  return result
}

function scrubError<T>(error: T, secrets: readonly string[]): T {
  if (typeof error === 'string') return scrubSecrets(error, secrets) as T
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const target = current as Record<string, unknown>
    try {
      if (current instanceof Error) {
        current.message = scrubSecrets(current.message, secrets)
        if (typeof current.stack === 'string') current.stack = scrubSecrets(current.stack, secrets)
      }
      // Error objects from child_process, URL parsing or custom runners carry
      // the command line or raw input on extra properties (`cmd`, `input`,
      // `spawnargs`, ...) that loggers serialize, so scrub those too.
      for (const key of Object.keys(target)) {
        const value = target[key]
        if (typeof value === 'string') target[key] = scrubSecrets(value, secrets)
        else if (Array.isArray(value)) target[key] = value.map((item: unknown) => typeof item === 'string' ? scrubSecrets(item, secrets) : item)
      }
    } catch { /* frozen objects are left as they are */ }
    current = target.cause
  }
  return error
}

/** Returns the target without credentials, safe to persist and log. */
function redactTarget(target: BackupTarget): BackupTarget {
  if (target.kind !== 'tenant' || !target.databaseUrl) return target
  let databaseUrl: string
  try {
    const url = new URL(target.databaseUrl)
    if (url.password) url.password = '***'
    for (const param of PASSWORD_PARAMS) if (url.searchParams.has(param)) url.searchParams.set(param, '***')
    databaseUrl = url.toString()
  } catch {
    databaseUrl = '***'
  }
  return { ...target, databaseUrl }
}

async function runCommand(command: string, args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<void> {
  const name = basename(command)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString() })
    child.on('error', (error) => reject(new BackupCommandError(name, new Error(scrubSecrets(error.message)))))
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new BackupCommandError(`${name} exited with code ${String(code)}`, new Error(scrubSecrets(stderr.trim())))))
  })
}
