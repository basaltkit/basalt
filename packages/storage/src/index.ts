import {
  createToken,
  definePlugin,
  parseDuration,
  tryCtx,
  type DurationInput,
} from '@machize/core'
import type { PutOptions, StorageDriver } from './driver.js'
import { LocalStorageDriver } from './drivers/local.js'
import { S3StorageDriver, type S3DriverOptions } from './drivers/s3.js'
import { TemporaryUrlUnsupportedError, UnknownDiskError } from './errors.js'

export type { StorageDriver, PutOptions } from './driver.js'
export { LocalStorageDriver } from './drivers/local.js'
export { S3StorageDriver, type S3DriverOptions } from './drivers/s3.js'
export {
  StorageFileNotFoundError,
  StorageInvalidPathError,
  TemporaryUrlUnsupportedError,
  UnknownDiskError,
} from './errors.js'

export interface DiskOptions {
  /**
   * Dynamic path prefix resolved on every operation. The default reads
   * `ctx().tenant.id` — automatic tenant isolation. Pass `null` to disable.
   */
  scope?: (() => string | undefined) | null
}

const defaultScope = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ? `tenants/${tenant.id}` : undefined
}

/** A named disk: driver + tenant scoping. All app code talks to this API. */
export class Disk {
  private readonly scope: (() => string | undefined) | null

  constructor(
    readonly name: string,
    private readonly driver: StorageDriver,
    options: DiskOptions = {},
  ) {
    this.scope = options.scope === undefined ? defaultScope : options.scope
  }

  put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    return this.driver.put(this.path(path), content, options)
  }

  get(path: string): Promise<Buffer> {
    return this.driver.get(this.path(path))
  }

  exists(path: string): Promise<boolean> {
    return this.driver.exists(this.path(path))
  }

  delete(path: string): Promise<boolean> {
    return this.driver.delete(this.path(path))
  }

  list(prefix = ''): Promise<string[]> {
    return this.driver.list(this.path(prefix))
  }

  /** Pre-signed URL: `disk.temporaryUrl('report.pdf', '15m')`. */
  temporaryUrl(path: string, expiresIn: DurationInput): Promise<string> {
    if (!this.driver.temporaryUrl) throw new TemporaryUrlUnsupportedError(this.driver.name)
    return this.driver.temporaryUrl(this.path(path), parseDuration(expiresIn))
  }

  private path(path: string): string {
    const scope = this.scope?.()
    return scope ? `${scope}/${path}` : path
  }
}

export class Storage {
  private readonly disks = new Map<string, Disk>()

  constructor(private readonly defaultDisk?: string) {}

  add(disk: Disk): this {
    this.disks.set(disk.name, disk)
    return this
  }

  disk(name?: string): Disk {
    const diskName = name ?? this.defaultDisk ?? this.disks.keys().next().value
    const disk = diskName === undefined ? undefined : this.disks.get(diskName)
    if (!disk) throw new UnknownDiskError(String(diskName ?? '(none configured)'))
    return disk
  }
}

export const STORAGE = createToken<Storage>('storage')

export type DiskConfig =
  | ({ driver: 'local'; root: string } & DiskOptions)
  | ({ driver: 's3' } & S3DriverOptions & DiskOptions)

export interface StoragePluginOptions {
  disks: Record<string, DiskConfig>
  /** Disk returned by `storage.disk()` with no argument. */
  default?: string
}

export function storagePlugin(options: StoragePluginOptions) {
  const drivers: StorageDriver[] = []
  return definePlugin({
    name: 'machize:storage',
    register({ container }) {
      container.singleton(STORAGE, () => {
        const storage = new Storage(options.default)
        for (const [name, config] of Object.entries(options.disks)) {
          const driver: StorageDriver =
            config.driver === 'local'
              ? new LocalStorageDriver({ root: config.root })
              : new S3StorageDriver(config)
          drivers.push(driver)
          storage.add(
            new Disk(name, driver, config.scope !== undefined ? { scope: config.scope } : {}),
          )
        }
        return storage
      })
    },
    async shutdown() {
      await Promise.all(drivers.map((driver) => driver.disconnect()))
    },
  })
}
