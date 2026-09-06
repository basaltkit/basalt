import { describe, expect, it } from 'vitest'
import { Disk, type StorageDriver } from '@basaltkit/storage'
import { PostgresBackup } from '../src/postgres.js'

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

describe('PostgresBackup', () => {
  it('creates a custom-format dump and records its checksum', async () => {
    const driver = new MemoryDriver()
    const calls: string[][] = []
    const backup = new PostgresBackup({
      connectionUrl: 'postgresql://user:pass@localhost/app',
      disk: new Disk('backups', driver, { scope: null }),
      runner: async (_command, args) => { calls.push(args); const file = args[args.indexOf('--file') + 1]!; const { writeFile } = await import('node:fs/promises'); await writeFile(file, 'dump') },
      clock: () => new Date('2026-09-06T12:00:00Z'),
    })
    const result = await backup.create({ kind: 'full' })
    expect(result.status).toBe('succeeded')
    expect(result.sizeBytes).toBe(4)
    expect(result.sha256).toBe('b6ca0868bca6a2926b70aa1a71592038d9030fe26d4214edcfbd6cf41f2f4654')
    expect(calls[0]).toContain('--format=custom')
    expect(calls[0]).toContain('postgresql://user:pass@localhost/app')
    expect(calls[0]).not.toContain('schema=public')
    expect(await backup.list()).toHaveLength(1)
  })

  it('uses tenant schema naming and prunes old successful backups', async () => {
    const driver = new MemoryDriver()
    let count = 0
    const backup = new PostgresBackup({
      connectionUrl: 'postgresql://localhost/app', disk: new Disk('backups', driver, { scope: null }), retention: 1,
      runner: async (_command, args) => { count++; const file = args[args.indexOf('--file') + 1]!; const { writeFile } = await import('node:fs/promises'); await writeFile(file, String(count)) },
      clock: () => new Date('2026-09-06T12:00:00Z'),
    })
    await backup.create({ kind: 'tenant', tenantId: 'Acme Ltd' })
    await backup.create({ kind: 'tenant', tenantId: 'Acme Ltd' })
    const manifests = await backup.list()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]?.target).toEqual({ kind: 'tenant', tenantId: 'Acme Ltd' })
  })

  it('ignores an incomplete manifest while listing backups', async () => {
    const driver = new MemoryDriver()
    driver.files.set('backups/incomplete.json', Buffer.from(''))
    const backup = new PostgresBackup({
      connectionUrl: 'postgresql://localhost/app',
      disk: new Disk('backups', driver, { scope: null }),
    })

    await expect(backup.list()).resolves.toEqual([])
  })
})
