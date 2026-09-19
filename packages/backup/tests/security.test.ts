import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Disk, type StorageDriver } from '@basaltkit/storage'
import type { Logger } from '@basaltkit/logger'
import { BackupIntegrityError, PostgresBackup, type CommandRunner } from '../src/index.js'

class MemoryDriver implements StorageDriver {
  readonly name = 'memory'
  readonly files = new Map<string, Buffer>()
  async put(path: string, content: Buffer | string): Promise<void> { this.files.set(path, Buffer.from(content)) }
  async get(path: string): Promise<Buffer> { const value = this.files.get(path); if (!value) throw new Error(path); return value }
  async exists(path: string): Promise<boolean> { return this.files.has(path) }
  async delete(path: string): Promise<boolean> { return this.files.delete(path) }
  async list(prefix: string): Promise<string[]> { return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort() }
  async disconnect(): Promise<void> {}
}

const SECRET = 'S3cretPassw0rd'
const CENTRAL_URL = `postgresql://app:${SECRET}@db.internal:5432/app?schema=public`
const TENANT_SECRET = 'T3nantP%40ss'

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`${level} ${JSON.stringify(args, (_key, value: unknown) => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value)}`)
  }
  const logger = {
    info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'), trace: record('trace'), fatal: record('fatal'),
    child: () => logger,
  } as unknown as Logger
  return { logger, lines }
}

function everything(driver: MemoryDriver, lines: string[], extra: unknown[] = []): string {
  return [
    ...[...driver.files.values()].map((value) => value.toString()),
    ...lines,
    ...extra.map((value) => value instanceof Error ? `${value.message} ${String(value.cause instanceof Error ? value.cause.message : '')}` : JSON.stringify(value)),
  ].join('\n')
}

describe('backup security: credentials never leak (F49)', () => {
  let folder: string
  let failingTool: string

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'basalt-backup-sec-'))
    failingTool = join(folder, 'fake-pg-dump.sh')
    // Mimics pg_dump echoing its connection string on failure.
    await writeFile(failingTool, '#!/bin/sh\necho "pg_dump: error: connection to $* failed: FATAL: password authentication failed" >&2\nexit 1\n', { mode: 0o755 })
  })
  afterAll(async () => { await rm(folder, { recursive: true, force: true }) })

  it('keeps the database password out of the manifest, logs and thrown error when pg_dump fails', async () => {
    const driver = new MemoryDriver()
    const { logger, lines } = recordingLogger()
    const backup = new PostgresBackup({
      connectionUrl: CENTRAL_URL,
      disk: new Disk('backups', driver, { scope: null }),
      pgDumpPath: failingTool,
      logger,
    })
    const error = await backup.create({ kind: 'full' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    const manifest = JSON.parse([...driver.files.values()][0]!.toString()) as { status: string; error: string }
    expect(manifest.status).toBe('failed')
    expect(everything(driver, lines, [error])).not.toContain(SECRET)
  })

  it('never passes the password on the command line and hands it to the tool via PGPASSWORD', async () => {
    const driver = new MemoryDriver()
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = []
    const runner: CommandRunner = async (_command, args, options) => {
      seen.push({ args, ...(options.env ? { env: options.env } : {}) })
      const index = args.indexOf('--file')
      if (index >= 0) await writeFile(args[index + 1]!, 'dump')
    }
    const backup = new PostgresBackup({ connectionUrl: CENTRAL_URL, disk: new Disk('backups', driver, { scope: null }), runner })
    const manifest = await backup.create({ kind: 'full' })
    await backup.restore(manifest.id, `postgresql://restore:${SECRET}@db.internal/target`, { confirm: () => true })
    expect(seen).toHaveLength(2)
    for (const call of seen) {
      expect(call.args.join(' ')).not.toContain(SECRET)
      expect(call.env?.PGPASSWORD).toBe(SECRET)
    }
    expect(seen[0]!.args).toContain('postgresql://app@db.internal:5432/app')
  })

  it('redacts a tenant databaseUrl before persisting or logging the target', async () => {
    const driver = new MemoryDriver()
    const { logger, lines } = recordingLogger()
    let env: Record<string, string> | undefined
    const backup = new PostgresBackup({
      connectionUrl: CENTRAL_URL,
      disk: new Disk('backups', driver, { scope: null }),
      logger,
      runner: async (_command, args, options) => {
        env = options.env
        await writeFile(args[args.indexOf('--file') + 1]!, 'dump')
      },
    })
    const manifest = await backup.create({ kind: 'tenant', tenantId: 't1', databaseUrl: `postgres://tenant:${TENANT_SECRET}@tenant-db/t1` })
    expect(env?.PGPASSWORD).toBe('T3nantP@ss')
    expect(manifest.mode).toBe('database')
    const all = everything(driver, lines, [manifest])
    expect(all).not.toContain(TENANT_SECRET)
    expect(all).not.toContain('T3nantP@ss')
  })

  it('scrubs credentials from runner errors and from an unparsable connection URL', async () => {
    const driver = new MemoryDriver()
    const { logger, lines } = recordingLogger()
    const backup = new PostgresBackup({
      connectionUrl: CENTRAL_URL,
      disk: new Disk('backups', driver, { scope: null }),
      logger,
      runner: async () => { throw new Error(`could not connect to postgresql://app:${SECRET}@db.internal/app password=${SECRET}`) },
    })
    const error = await backup.create({ kind: 'full' }).catch((caught: unknown) => caught)
    expect(everything(driver, lines)).not.toContain(SECRET)
    expect(error).toBeInstanceOf(Error)

    const broken = new PostgresBackup({
      connectionUrl: `postgresql://app:${SECRET}@[bad-host/app`,
      disk: new Disk('backups', new MemoryDriver(), { scope: null }),
      runner: async () => {},
    })
    const invalid = await broken.create({ kind: 'full' }).catch((caught: unknown) => caught)
    expect(JSON.stringify(invalid, Object.getOwnPropertyNames(invalid))).not.toContain(SECRET)
  })
  it('scrubs credentials from extra error properties such as execFile cmd and URL input', async () => {
    const execFileAsync = promisify(execFile)
    const driver = new MemoryDriver()
    const { logger, lines } = recordingLogger()
    const seenErrors: unknown[] = []
    const record = logger.error.bind(logger)
    ;(logger as unknown as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
      seenErrors.push(...args)
      record(...(args as Parameters<typeof record>))
    }
    // A runner built on execFile, as in the documented Docker runner: Node puts
    // the whole command line on `error.cmd`, which loggers serialize.
    const backup = new PostgresBackup({
      connectionUrl: `postgresql://app:${SECRET}@db.internal/app?sslpassword=K3yPassphrase`,
      disk: new Disk('backups', driver, { scope: null }),
      logger,
      runner: async (_command, args, options) => { await execFileAsync(failingTool, args, { env: { ...process.env, ...options.env } }) },
    })
    const error = await backup.create({ kind: 'full' }).catch((caught: unknown) => caught)
    // A tenant URL resolver that fails in `new URL()` puts the raw URL on `input`.
    const resolver = new PostgresBackup({
      connectionUrl: 'postgresql://app@db.internal/app',
      disk: new Disk('backups', driver, { scope: null }),
      logger,
      tenantDatabaseUrl: (tenantId) => new URL(`postgresql://tenant:TenantPw9@[bad-host/${tenantId}`).toString(),
      runner: async () => {},
    })
    const invalid = await resolver.create({ kind: 'tenant', tenantId: 't1' }).catch((caught: unknown) => caught)
    const dump = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item instanceof Error
      ? { ...item, message: item.message, stack: item.stack, cause: item.cause }
      : item)
    const all = [everything(driver, lines), dump(error), dump(invalid), dump(seenErrors)].join('\n')
    for (const secret of [SECRET, 'K3yPassphrase', 'TenantPw9']) expect(all).not.toContain(secret)
  })
})


describe('backup security: restore verifies integrity (F50)', () => {
  async function setup() {
    const driver = new MemoryDriver()
    const restored: string[] = []
    const backup = new PostgresBackup({
      connectionUrl: 'postgresql://localhost/app',
      disk: new Disk('backups', driver, { scope: null }),
      runner: async (command, args) => {
        if (command === 'pg_dump') await writeFile(args[args.indexOf('--file') + 1]!, 'original dump')
        else restored.push(args[args.length - 1]!)
      },
    })
    const manifest = await backup.create({ kind: 'full' })
    return { driver, backup, manifest, restored }
  }

  it('restores an untampered artifact', async () => {
    const { backup, manifest, restored } = await setup()
    await backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true })
    expect(restored).toHaveLength(1)
  })

  it('refuses to restore an artifact whose sha256 does not match the manifest', async () => {
    const { driver, backup, manifest, restored } = await setup()
    driver.files.set(`backups/${manifest.id}.dump`, Buffer.from('tampered dump'))
    await expect(backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true }))
      .rejects.toBeInstanceOf(BackupIntegrityError)
    expect(restored).toHaveLength(0)
  })

  it('refuses a manifest that points its artifact outside the canonical path', async () => {
    const { driver, backup, manifest, restored } = await setup()
    driver.files.set('backups/evil.dump', Buffer.from('attacker dump'))
    const { createHash } = await import('node:crypto')
    const forged = { ...manifest, artifact: 'backups/evil.dump', sha256: createHash('sha256').update('attacker dump').digest('hex') }
    driver.files.set(`backups/${manifest.id}.json`, Buffer.from(JSON.stringify(forged)))
    await expect(backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true }))
      .rejects.toBeInstanceOf(BackupIntegrityError)
    expect(restored).toHaveLength(0)
  })

  it('refuses a succeeded manifest without a recorded sha256', async () => {
    const { driver, backup, manifest, restored } = await setup()
    const { sha256: _omit, ...withoutHash } = manifest
    driver.files.set(`backups/${manifest.id}.json`, Buffer.from(JSON.stringify(withoutHash)))
    await expect(backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true }))
      .rejects.toBeInstanceOf(BackupIntegrityError)
    expect(restored).toHaveLength(0)
  })
})
