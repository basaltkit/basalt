import {
  createToken,
  definePlugin,
  parseDuration,
  tryCtx,
  type DurationInput,
} from '@basaltkit/core'
import type { TemporaryUrlOptions, PutOptions, StorageDriver } from './driver.js'
import { ImagePipeline, type ImageProcessor } from './image.js'
import { LocalStorageDriver } from './drivers/local.js'
import {
  StorageContentTypeError,
  StorageInvalidKeyError,
  StorageTooLargeError,
  TemporaryUrlUnsupportedError,
  UnknownDiskError,
} from './errors.js'

export type { StorageDriver, PutOptions, TemporaryUrlOptions } from './driver.js'
export {
  ImagePipeline,
  type ImageProcessor,
  type ImageOp,
  type ImageFormat,
  type ImageMetadata,
  type ResizeOptions,
} from './image.js'
export { LocalStorageDriver } from './drivers/local.js'
export {
  ImageProcessingUnavailableError,
  StorageContentTypeError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageInvalidPathError,
  StorageTooLargeError,
  TemporaryUrlUnsupportedError,
  UnknownDiskError,
} from './errors.js'

// eslint-disable-next-line no-control-regex -- NUL/control chars are exactly what we reject
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Shared key guard for every driver (L-3). Cloud drivers forward object keys
 * verbatim, so this runs at the facade choke point — the one layer all drivers
 * pass through — rejecting keys that could produce confusing/duplicate objects
 * or defeat prefix-based `list()` isolation. Conservative: normal nested keys
 * like `avatars/123/pic.png` are untouched.
 */
function assertValidKey(key: string): void {
  if (
    key.startsWith('/') ||
    key.startsWith('\\') ||
    CONTROL_CHARS.test(key) ||
    key.split(/[/\\]+/).some((segment) => segment === '..')
  ) {
    throw new StorageInvalidKeyError(key)
  }
}

/**
 * Shared upload guard for every driver (L-4). Both limits are opt-in, so with
 * no options set behavior is unchanged. Byte size is enforced for `Buffer` and
 * `string` inputs — for those the length is known up front. The driver contract
 * only accepts `Buffer | string`, so there is no unmeasured-stream case here; a
 * future streaming input would need enforcement pushed into the driver.
 */
function enforceUploadLimits(content: Buffer | string, options: PutOptions | undefined): void {
  if (!options) return
  if (options.maxBytes !== undefined) {
    const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength
    if (bytes > options.maxBytes) throw new StorageTooLargeError(bytes, options.maxBytes)
  }
  if (options.allowedContentTypes && !options.allowedContentTypes.includes(options.contentType ?? '')) {
    throw new StorageContentTypeError(options.contentType, options.allowedContentTypes)
  }
}

export interface DiskOptions {
  /**
   * Dynamic path prefix resolved on every operation. The default reads
   * `ctx().tenant.id` — automatic tenant isolation. Pass `null` to disable.
   */
  scope?: (() => string | undefined) | null
  /** Engine that backs `disk.image(...)`. Injected by `storagePlugin`. */
  imageProcessor?: ImageProcessor
}

const defaultScope = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  return tenant?.id ? `tenants/${tenant.id}` : undefined
}

/** A named disk: driver + tenant scoping. All app code talks to this API. */
export class Disk {
  private readonly scope: (() => string | undefined) | null
  private readonly imageProcessor: ImageProcessor | undefined

  constructor(
    readonly name: string,
    private readonly driver: StorageDriver,
    options: DiskOptions = {},
  ) {
    this.scope = options.scope === undefined ? defaultScope : options.scope
    this.imageProcessor = options.imageProcessor
  }

  /**
   * Opens a fluent image pipeline reading `path` from this disk:
   * `disk.image('a.png').resize(256, 256).webp().save('a.webp')`. Requires an
   * `imageProcessor` (from `@basaltkit/image-sharp`); otherwise the terminal
   * throws `ImageProcessingUnavailableError`.
   */
  image(path: string): ImagePipeline {
    return new ImagePipeline(
      () => this.get(path),
      this.imageProcessor,
      (target, content, options) => this.put(target, content, options),
    )
  }

  // async so a rejected path (this.path throws) surfaces as a rejected promise,
  // consistent with the driver's own async errors.
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    const key = this.path(path)
    enforceUploadLimits(content, options)
    return this.driver.put(key, content, options)
  }

  async get(path: string): Promise<Buffer> {
    return this.driver.get(this.path(path))
  }

  async exists(path: string): Promise<boolean> {
    return this.driver.exists(this.path(path))
  }

  async delete(path: string): Promise<boolean> {
    return this.driver.delete(this.path(path))
  }

  async list(prefix = ''): Promise<string[]> {
    return this.driver.list(this.path(prefix))
  }

  /**
   * Pre-signed URL: `disk.temporaryUrl('report.pdf', '15m')`.
   *
   * Served as `Content-Disposition: attachment` by default (fail-closed
   * against uploaded HTML/SVG rendering on the storage origin); pass
   * `{ disposition: 'inline' }` when top-level rendering is deliberate.
   * Embedded uses (<img> etc.) render regardless of disposition.
   */
  temporaryUrl(path: string, expiresIn: DurationInput, options: TemporaryUrlOptions = {}): Promise<string> {
    if (!this.driver.temporaryUrl) throw new TemporaryUrlUnsupportedError(this.driver.name)
    return this.driver.temporaryUrl(this.path(path), parseDuration(expiresIn), {
      disposition: options.disposition ?? 'attachment',
    })
  }

  private path(path: string): string {
    // Validate the caller key BEFORE scoping, so it can never `..` its way out
    // of the tenant prefix and every driver — not just the local one, which
    // guards only the disk root — gets the same key guarantee (L-3).
    assertValidKey(path)
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
  /**
   * A driver instance — every backend but `local` arrives this way:
   * `@basaltkit/storage-s3`, `-azure`, `-gcs`, or one you wrote.
   *
   * S3 used to have a `{ driver: 's3' }` shorthand here, which is why this
   * package depended on the AWS SDK and shipped 4.4 MB to consumers who never
   * touched S3. Use `s3Disk({ bucket })` from `@basaltkit/storage-s3` instead.
   */
  | ({ driver: StorageDriver } & DiskOptions)

export interface StoragePluginOptions {
  disks: Record<string, DiskConfig>
  /** Disk returned by `storage.disk()` with no argument. */
  default?: string
  /**
   * Image engine shared by every disk's `.image(...)` pipeline. Pass a
   * `SharpImageProcessor` from `@basaltkit/image-sharp` (native `sharp`) — kept
   * out of the core so apps that never process images carry no native dep.
   */
  imageProcessor?: ImageProcessor
}

export function storagePlugin(options: StoragePluginOptions) {
  const drivers: StorageDriver[] = []
  return definePlugin({
    name: 'basalt:storage',
    register({ container }) {
      container.singleton(STORAGE, () => {
        const storage = new Storage(options.default)
        for (const [name, config] of Object.entries(options.disks)) {
          // `local` is the only string left: it needs no client library, just
          // `fs`. Everything else arrives as an instance from its own package.
          const driver: StorageDriver =
            typeof config.driver === 'string'
              ? new LocalStorageDriver({ root: config.root })
              : config.driver
          drivers.push(driver)
          storage.add(
            new Disk(name, driver, {
              ...(config.scope !== undefined ? { scope: config.scope } : {}),
              ...(options.imageProcessor ? { imageProcessor: options.imageProcessor } : {}),
            }),
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
