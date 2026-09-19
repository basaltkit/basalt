import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Disk, StorageFileNotFoundError, type PutStreamOptions, type StorageDriver } from '@basaltkit/storage'
import { BackupIntegrityError, PostgresBackup } from '../src/index.js'

/** A memory driver that implements the BK-019 streaming capabilities. */
class StreamingMemoryDriver implements StorageDriver {
  readonly name = 'memory-stream'
  readonly files = new Map<string, Buffer>()
  readonly streamed: { path: string; options: PutStreamOptions }[] = []
  readonly getStreamed: string[] = []
  async put(path: string, content: Buffer | string): Promise<void> {
    this.files.set(path, Buffer.from(content))
  }
  async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> {
    this.streamed.push({ path, options })
    const chunks: Buffer[] = []
    for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
    this.files.set(path, Buffer.concat(chunks))
  }
  async get(path: string): Promise<Buffer> {
    const value = this.files.get(path)
    if (!value) throw new StorageFileNotFoundError(path)
    return value
  }
  async getStream(path: string): Promise<Readable> {
    this.getStreamed.push(path)
    return Readable.from([await this.get(path)])
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async delete(path: string): Promise<boolean> {
    return this.files.delete(path)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).sort()
  }
  async disconnect(): Promise<void> {}
}

const dump = 'a custom-format dump, pretending to be large'

async function setup() {
  const driver = new StreamingMemoryDriver()
  const restored: string[] = []
  const backup = new PostgresBackup({
    connectionUrl: 'postgresql://localhost/app',
    disk: new Disk('backups', driver, { scope: null }),
    runner: async (command, args) => {
      if (command === 'pg_dump') await writeFile(args[args.indexOf('--file') + 1]!, dump)
      else restored.push(args[args.length - 1]!)
    },
  })
  return { driver, backup, restored }
}

describe('BK-019 · backup streams dumps to and from the disk', () => {
  it('streams the artifact out with a known length, and hashes it without buffering', async () => {
    const { driver, backup } = await setup()
    const manifest = await backup.create({ kind: 'full' })
    expect(manifest.status).toBe('succeeded')
    expect(manifest.sizeBytes).toBe(Buffer.byteLength(dump))
    expect(manifest.sha256).toBe(createHash('sha256').update(dump).digest('hex'))
    // The dump went through putStream; only the small JSON manifest used put.
    expect(driver.streamed.map((call) => call.path)).toEqual([`backups/${manifest.id}.dump`])
    expect(driver.streamed[0]?.options).toMatchObject({
      contentType: 'application/octet-stream',
      contentLength: Buffer.byteLength(dump),
    })
    expect(driver.files.get(`backups/${manifest.id}.dump`)?.toString()).toBe(dump)
  })

  it('streams the artifact back on restore and still verifies its checksum first', async () => {
    const { driver, backup, restored } = await setup()
    const manifest = await backup.create({ kind: 'full' })
    await backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true })
    expect(driver.getStreamed).toEqual([`backups/${manifest.id}.dump`])
    expect(restored).toHaveLength(1)
  })

  it('refuses a tampered artifact before pg_restore runs, on the streaming path too', async () => {
    const { driver, backup, restored } = await setup()
    const manifest = await backup.create({ kind: 'full' })
    driver.files.set(`backups/${manifest.id}.dump`, Buffer.from('tampered dump'))
    await expect(backup.restore(manifest.id, 'postgresql://localhost/target', { confirm: () => true })).rejects.toBeInstanceOf(
      BackupIntegrityError,
    )
    expect(restored).toHaveLength(0)
  })
})
