import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StorageFileNotFoundError, StorageInvalidPathError } from '../errors.js'
import type { CopyDriverOptions, PutOptions, PutStreamOptions, StorageDriver, StorageStat } from '../driver.js'

/** Filesystem driver — the default for local development and simple deployments. */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local'
  private readonly root: string

  constructor(options: { root: string }) {
    this.root = resolve(options.root)
  }

  async put(path: string, content: Buffer | string, _options?: PutOptions): Promise<void> {
    const target = this.resolve(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  /**
   * Writes the stream to disk. On failure — including the Disk layer's
   * `maxBytes` abort — the partial file is removed, so a rejected upload never
   * leaves a truncated object behind.
   */
  async putStream(path: string, source: Readable, _options: PutStreamOptions): Promise<void> {
    const target = this.resolve(path)
    await mkdir(dirname(target), { recursive: true })
    try {
      await pipeline(source, createWriteStream(target))
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async get(path: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageFileNotFoundError(path)
      }
      throw error
    }
  }

  async getStream(path: string): Promise<Readable> {
    const target = this.resolve(path)
    // Checked before the stream is opened so a missing file fails the same way
    // `get` does, instead of emitting ENOENT at some later tick.
    await this.statFile(target, path)
    return createReadStream(target)
  }

  async copy(from: string, to: string, _options?: CopyDriverOptions): Promise<void> {
    const source = this.resolve(from)
    const target = this.resolve(to)
    await this.statFile(source, from)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  /** The filesystem stores no content type or etag, so only size and mtime are reported. */
  async stat(path: string): Promise<StorageStat> {
    const stats = await this.statFile(this.resolve(path), path)
    return { size: stats.size, lastModified: stats.mtime }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolve(path))
      return true
    } catch {
      return false
    }
  }

  async delete(path: string): Promise<boolean> {
    try {
      await rm(this.resolve(path))
      return true
    } catch {
      return false
    }
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.resolve(prefix)
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else files.push(relative(this.root, full).split(sep).join('/'))
      }
    }
    await walk(base)
    return files.sort()
  }

  async disconnect(): Promise<void> {}

  /** `fs.stat`, turning ENOENT (and a directory) into the shared not-found error. */
  private async statFile(target: string, path: string): Promise<{ size: number; mtime: Date }> {
    try {
      const stats = await stat(target)
      if (!stats.isFile()) throw new StorageFileNotFoundError(path)
      return { size: stats.size, mtime: stats.mtime }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  /** Resolves a path inside the root, rejecting traversal attempts. */
  private resolve(path: string): string {
    const target = resolve(this.root, path)
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new StorageInvalidPathError(path)
    }
    return target
  }
}
