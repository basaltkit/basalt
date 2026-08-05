import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { StorageFileNotFoundError, StorageInvalidPathError } from '../errors.js'
import type { PutOptions, StorageDriver } from '../driver.js'

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

  /** Resolves a path inside the root, rejecting traversal attempts. */
  private resolve(path: string): string {
    const target = resolve(this.root, path)
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new StorageInvalidPathError(path)
    }
    return target
  }
}
