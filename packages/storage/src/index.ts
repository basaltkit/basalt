import {
  createToken,
  definePlugin,
  ensureMetadata,
  parseDuration,
  tryCtx,
  type DurationInput,
} from '@basaltkit/core'
import type {
  TemporaryUploadUrl,
  TemporaryUploadUrlDriverOptions,
  TemporaryUrlOptions,
  PutOptions,
  StorageDriver,
} from './driver.js'
import { ImagePipeline, type ImageProcessor } from './image.js'
import { LocalStorageDriver } from './drivers/local.js'
import {
  StorageContentTypeError,
  StorageInvalidKeyError,
  StorageInvalidScopeError,
  StorageTenantRequiredError,
  StorageTooLargeError,
  StorageUploadUrlInvalidError,
  TemporaryUploadUrlUnsupportedError,
  TemporaryUrlTtlTooLongError,
  TemporaryUrlUnsupportedError,
  UnknownDiskError,
} from './errors.js'

export type {
  StorageDriver,
  PutOptions,
  TemporaryUrlOptions,
  TemporaryUploadUrl,
  TemporaryUploadUrlDriverOptions,
} from './driver.js'
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
  StorageInvalidScopeError,
  StorageTenantRequiredError,
  StorageTooLargeError,
  StorageUploadUrlInvalidError,
  TemporaryUploadUrlUnsupportedError,
  TemporaryUrlTtlTooLongError,
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

/**
 * Largest lifetime a temporary URL may be minted with unless a disk sets
 * `maxTemporaryUrlTtl`: 7 days, the ceiling S3 and GCS V4 signatures enforce
 * natively. A signed URL is a bearer credential that survives the holder's
 * removal from the tenant, so it must not be near-permanent.
 */
export const DEFAULT_MAX_TEMPORARY_URL_TTL = 7 * 24 * 60 * 60 * 1000

/**
 * Largest lifetime a pre-signed upload URL may be minted with unless a disk
 * sets `maxTemporaryUploadUrlTtl`: 1 hour. An upload URL is a write credential
 * — the browser should use it right away, so it has no reason to live long.
 */
export const DEFAULT_MAX_TEMPORARY_UPLOAD_URL_TTL = 60 * 60 * 1000

/** Options for {@link Disk.temporaryUploadUrl}. */
export interface TemporaryUploadUrlOptions {
  /** URL lifetime. Capped by `maxTemporaryUploadUrlTtl` (default 1 hour). */
  expiresIn: DurationInput
  /**
   * Required. The only Content-Type the upload may declare — signed into the
   * URL, so the client cannot upload `text/html` to a URL minted for `image/png`.
   */
  contentType: string
  /** Exact body size in bytes. Signed on S3; a size range on GCS; not bindable on Azure. */
  contentLength?: number
  /** Base64-encoded SHA-256 of the body. Signed on S3 (S3 verifies it); unsupported on GCS. */
  checksumSha256?: string
  /**
   * Facade-enforced cap on the declared `contentLength` (like `PutOptions.maxBytes`).
   * When set, `contentLength` becomes mandatory — the signature is what enforces it.
   */
  maxBytes?: number
  /** Facade-enforced allowlist for the declared `contentType` (like `PutOptions.allowedContentTypes`). */
  allowedContentTypes?: readonly string[]
}

// type/subtype with optional parameters; no whitespace runs, CR/LF or other control chars.
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:; ?[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\u0000-\u001f\u007f]*"))*$/i
// 32 bytes, base64: 43 characters + one '=' pad.
const SHA256_BASE64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

function validateUploadUrlOptions(options: TemporaryUploadUrlOptions): TemporaryUploadUrlDriverOptions {
  const { contentType, contentLength, checksumSha256, maxBytes, allowedContentTypes } = options
  if (typeof contentType !== 'string' || !CONTENT_TYPE.test(contentType)) {
    throw new StorageUploadUrlInvalidError('contentType is required and must be a valid media type (e.g. "image/png").')
  }
  if (contentLength !== undefined && !(Number.isSafeInteger(contentLength) && contentLength >= 0)) {
    throw new StorageUploadUrlInvalidError('contentLength must be a non-negative integer.')
  }
  if (checksumSha256 !== undefined && !SHA256_BASE64.test(checksumSha256)) {
    throw new StorageUploadUrlInvalidError('checksumSha256 must be the base64-encoded 32-byte SHA-256 digest.')
  }
  if (allowedContentTypes && !allowedContentTypes.includes(contentType)) {
    throw new StorageContentTypeError(contentType, allowedContentTypes)
  }
  if (maxBytes !== undefined) {
    if (contentLength === undefined) {
      throw new StorageUploadUrlInvalidError('maxBytes requires a declared contentLength, so the signature can enforce it.')
    }
    if (contentLength > maxBytes) throw new StorageTooLargeError(contentLength, maxBytes)
  }
  return {
    contentType,
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(checksumSha256 !== undefined ? { checksumSha256 } : {}),
  }
}

export interface DiskOptions {
  /**
   * Dynamic path prefix resolved on every operation. The default reads
   * `ctx().tenant.id` — automatic tenant isolation (`tenants/<id>/`). Pass
   * `null` to disable (a deliberately central disk: backups, branding).
   */
  scope?: (() => string | undefined) | null
  /**
   * What an operation does when the scope resolves nothing (no tenant in
   * context): `'root'` uses the caller's key against the disk root — where
   * every tenant's `tenants/<id>/` tree lives; `'error'` throws
   * {@link StorageTenantRequiredError}. Default: `'error'` when
   * `@basaltkit/tenancy` is registered (via `storagePlugin`) and the disk uses
   * the default scope, `'root'` otherwise. An explicit value always wins.
   */
  onMissingScope?: 'root' | 'error'
  /**
   * Upper bound for `temporaryUrl` lifetimes. Default 7 days
   * ({@link DEFAULT_MAX_TEMPORARY_URL_TTL}); a longer request throws
   * {@link TemporaryUrlTtlTooLongError} (400).
   */
  maxTemporaryUrlTtl?: DurationInput
  /**
   * Upper bound for `temporaryUploadUrl` lifetimes. Default: the smaller of
   * 1 hour ({@link DEFAULT_MAX_TEMPORARY_UPLOAD_URL_TTL}) and
   * `maxTemporaryUrlTtl`; an explicit value wins. A longer request throws
   * {@link TemporaryUrlTtlTooLongError} (400).
   */
  maxTemporaryUploadUrlTtl?: DurationInput
  /** Engine that backs `disk.image(...)`. Injected by `storagePlugin`. */
  imageProcessor?: ImageProcessor
}

const isUnsafeScopeSegment = (segment: string): boolean =>
  segment === '' || segment === '.' || segment === '..' || CONTROL_CHARS.test(segment)

const defaultScope = (): string | undefined => {
  const tenant = tryCtx()?.['tenant'] as { id?: string } | undefined
  if (!tenant?.id) return undefined
  // The id must be exactly one path segment. 'globex/files' would scope into
  // globex's tree and '..' would collapse onto the bucket root.
  if (/[/\\]/.test(tenant.id) || isUnsafeScopeSegment(tenant.id)) throw new StorageInvalidScopeError()
  return `tenants/${tenant.id}`
}

/** Any scope (default or custom) must be a relative, traversal-free prefix. */
function assertValidScope(scope: string): void {
  // Empty segments only come from a trailing separator here (a leading one is
  // refused and runs collapse in the split), so they are harmless.
  const segments = scope.split(/[/\\]+/).filter((segment) => segment !== '')
  if (scope.startsWith('/') || scope.startsWith('\\') || segments.some(isUnsafeScopeSegment)) {
    throw new StorageInvalidScopeError()
  }
}

/** A named disk: driver + tenant scoping. All app code talks to this API. */
export class Disk {
  private readonly scope: (() => string | undefined) | null
  private readonly onMissingScope: 'root' | 'error' | undefined
  private readonly maxTemporaryUrlTtl: number
  private readonly maxTemporaryUploadUrlTtl: number
  private readonly imageProcessor: ImageProcessor | undefined

  constructor(
    readonly name: string,
    private readonly driver: StorageDriver,
    options: DiskOptions = {},
    /**
     * Whether the host app registered `@basaltkit/tenancy`. `storagePlugin`
     * wires this to the container's `'tenancy:active'` metadata marker. It is
     * read on every operation, not once at construction, so the fail-closed
     * default does not depend on plugin order (a disk resolved before
     * tenancy registers). Defaults to `false` (single-tenant).
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.scope = options.scope === undefined ? defaultScope : options.scope
    this.onMissingScope = options.onMissingScope
    this.maxTemporaryUrlTtl =
      options.maxTemporaryUrlTtl === undefined ? DEFAULT_MAX_TEMPORARY_URL_TTL : parseDuration(options.maxTemporaryUrlTtl)
    this.maxTemporaryUploadUrlTtl =
      options.maxTemporaryUploadUrlTtl === undefined
        ? Math.min(DEFAULT_MAX_TEMPORARY_UPLOAD_URL_TTL, this.maxTemporaryUrlTtl)
        : parseDuration(options.maxTemporaryUploadUrlTtl)
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
  async temporaryUrl(path: string, expiresIn: DurationInput, options: TemporaryUrlOptions = {}): Promise<string> {
    if (!this.driver.temporaryUrl) throw new TemporaryUrlUnsupportedError(this.driver.name)
    const ttl = parseDuration(expiresIn)
    // Capped here, for every driver: a signed URL is a bearer credential that
    // outlives the holder's membership and role, so it must not be long-lived.
    if (!(ttl > 0) || ttl > this.maxTemporaryUrlTtl) throw new TemporaryUrlTtlTooLongError(ttl, this.maxTemporaryUrlTtl)
    return this.driver.temporaryUrl(this.path(path), ttl, {
      disposition: options.disposition ?? 'attachment',
    })
  }

  /**
   * Pre-signed direct upload: the browser PUTs the file straight to the
   * bucket, never through the app server.
   *
   * ```ts
   * const upload = await disk.temporaryUploadUrl(`avatars/${randomUUID()}.png`, {
   *   expiresIn: '5m', contentType: 'image/png', contentLength: 48_213,
   * })
   * // client: fetch(upload.url, { method: upload.method, headers: upload.headers, body: file })
   * ```
   *
   * Same safety rules as {@link temporaryUrl}: the key is validated and
   * tenant-prefixed (fail-closed without a tenant), and the lifetime is capped
   * by `maxTemporaryUploadUrlTtl` (default 1 hour). `contentType` is required
   * and signed; `contentLength`/`checksumSha256` are signed where the backend
   * can. Generate the key server-side — never accept it from the client.
   */
  async temporaryUploadUrl(path: string, options: TemporaryUploadUrlOptions): Promise<TemporaryUploadUrl> {
    if (!this.driver.temporaryUploadUrl) throw new TemporaryUploadUrlUnsupportedError(this.driver.name)
    const ttl = parseDuration(options.expiresIn)
    if (!(ttl > 0) || ttl > this.maxTemporaryUploadUrlTtl) {
      throw new TemporaryUrlTtlTooLongError(ttl, this.maxTemporaryUploadUrlTtl)
    }
    const driverOptions = validateUploadUrlOptions(options)
    const key = this.path(path)
    const upload = await this.driver.temporaryUploadUrl(key, ttl, driverOptions)
    return { ...upload, key }
  }

  private path(path: string): string {
    // Validate the caller key BEFORE scoping, so it can never `..` its way out
    // of the tenant prefix and every driver — not just the local one, which
    // guards only the disk root — gets the same key guarantee (L-3).
    assertValidKey(path)
    if (this.scope === null) return path // deliberately central disk
    const scope = this.scope()
    if (!scope) {
      // Fail closed in a multi-tenant app: without a tenant the key would be
      // resolved against the bucket root, where `tenants/<victim>/…` is
      // reachable by name and `list('tenants')` enumerates every tenant.
      if (this.missingScopeMode() === 'error') throw new StorageTenantRequiredError(this.name)
      return path
    }
    assertValidScope(scope)
    return `${scope}/${path}`
  }

  /**
   * An explicit `onMissingScope` wins. Otherwise a disk on the default tenant
   * scope fails closed whenever tenancy is registered, and uses the root when
   * it is not (single-tenant apps, standalone disks).
   */
  private missingScopeMode(): 'root' | 'error' {
    if (this.onMissingScope !== undefined) return this.onMissingScope
    return this.scope === defaultScope && this.tenancyActive() ? 'error' : 'root'
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
        // Fail closed by default in multi-tenant apps: when @basaltkit/tenancy
        // is registered (its 'tenancy:active' metadata marker), a disk on the
        // default tenant scope refuses to run without a tenant instead of
        // falling back to the bucket root. Same rule as @basaltkit/cache. A
        // custom `scope`, `scope: null` or an explicit `onMissingScope` wins.
        // Read lazily (per operation), so the marker is seen even when this
        // singleton is resolved before tenancyPlugin has registered.
        const tenancyActive = () => ensureMetadata(container).get('tenancy:active').length > 0
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
              ...(config.onMissingScope !== undefined ? { onMissingScope: config.onMissingScope } : {}),
              ...(config.maxTemporaryUrlTtl !== undefined ? { maxTemporaryUrlTtl: config.maxTemporaryUrlTtl } : {}),
              ...(config.maxTemporaryUploadUrlTtl !== undefined
                ? { maxTemporaryUploadUrlTtl: config.maxTemporaryUploadUrlTtl }
                : {}),
              ...(options.imageProcessor ? { imageProcessor: options.imageProcessor } : {}),
            }, tenancyActive),
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
