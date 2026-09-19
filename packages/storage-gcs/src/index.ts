import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
  type TemporaryUrlOptions,
  CopyUnsupportedError,
  GetStreamUnsupportedError,
  PutStreamUnsupportedError,
  StatUnsupportedError,
  StorageFileNotFoundError,
  TemporaryUploadUrlUnsupportedError,
  TemporaryUrlUnsupportedError,
  type CopyDriverOptions,
  type PutOptions,
  type PutStreamOptions,
  type StorageDriver,
  type StorageStat,
} from '@basaltkit/storage'

/**
 * The `getSignedUrl` config this driver sends: `action: 'read'` (download, with
 * `responseDisposition`) or a V4 `action: 'write'` (upload, with `contentType`
 * and optional signed `extensionHeaders`).
 */
export interface GcsSignedUrlConfig {
  action: 'read' | 'write'
  expires: number
  version?: 'v4'
  responseDisposition?: string
  contentType?: string
  extensionHeaders?: Record<string, string>
}

/** What `getMetadata()` returns, in the shape this driver reads. `size` may arrive as a string. */
export interface GcsObjectMetadata {
  size?: number | string
  contentType?: string
  etag?: string
  updated?: string
}

/** The subset of a `@google-cloud/storage` File this driver uses. */
export interface GcsFileLike {
  save(data: Buffer, options?: { contentType?: string }): Promise<unknown>
  download(): Promise<[Buffer]>
  exists(): Promise<[boolean]>
  delete(): Promise<unknown>
  getSignedUrl(config: GcsSignedUrlConfig): Promise<[string]>
  /** Resumable upload sink — GCS chunks whatever is piped into it. */
  createWriteStream?(options?: { contentType?: string; resumable?: boolean }): Writable
  createReadStream?(): Readable
  /** Server-side copy inside GCS (same or another bucket of the same project). */
  copy?(destination: GcsFileLike | string, options?: { metadata?: { contentType?: string } }): Promise<unknown>
  getMetadata?(): Promise<[GcsObjectMetadata]>
}

/** The subset of a `@google-cloud/storage` Bucket this driver uses. */
export interface GcsBucketLike {
  file(path: string): GcsFileLike
  getFiles(options?: { prefix?: string }): Promise<[{ name: string }[]]>
}

export interface GcsDriverOptions {
  bucket: string
  projectId?: string
  keyFilename?: string
  /** Injectable bucket — defaults to `@google-cloud/storage`. Tests pass a fake. */
  client?: GcsBucketLike
}

/**
 * GCS V4 signatures are computed for `storage.googleapis.com` (or the bucket's
 * own virtual host), and this driver signs through `file.getSignedUrl`, which
 * offers no endpoint parameter — so an override is refused instead of silently
 * ignored. Serve the bucket under another name with a bucket-bound hostname
 * and the SDK's own `cname`/`bucketBoundHostname` option.
 */
const ENDPOINT_UNSUPPORTED =
  'The "gcs" driver cannot sign a URL for a different endpoint: V4 signatures are bound to the bucket host. ' +
  'Use a bucket-bound hostname (cname) configured on the @google-cloud/storage client instead.'

const isNotFound = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 404

/**
 * GCS reports a missing object on the read stream, not when it is created, so
 * the not-found error surfaces to whoever consumes the stream. Leaving the
 * `for await` (an early `destroy()` included) destroys the source stream.
 */
async function* translateNotFound(source: Readable, path: string): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of source) yield chunk as Uint8Array
  } catch (error) {
    throw isNotFound(error) ? new StorageFileNotFoundError(path) : error
  }
}

/**
 * Google Cloud Storage driver for `@basaltkit/storage`. Uses
 * `@google-cloud/storage` (an optional peer dependency) via an injectable
 * bucket, so its logic is unit-tested without touching GCS.
 */
export class GcsStorageDriver implements StorageDriver {
  readonly name = 'gcs'
  private bucketPromise: Promise<GcsBucketLike> | undefined

  constructor(private readonly options: GcsDriverOptions) {}

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    await (await this.bucket())
      .file(path)
      .save(data, options?.contentType !== undefined ? { contentType: options.contentType } : {})
  }

  /**
   * `createWriteStream` — a resumable upload GCS chunks itself, so a body of
   * any size (and of unknown length) is uploaded without being held whole.
   */
  async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> {
    const file = (await this.bucket()).file(path)
    if (!file.createWriteStream) {
      throw new PutStreamUnsupportedError(this.name, 'The injected GCS client does not implement createWriteStream().')
    }
    await pipeline(source, file.createWriteStream(options.contentType !== undefined ? { contentType: options.contentType } : {}))
  }

  async get(path: string): Promise<Buffer> {
    try {
      const [buffer] = await (await this.bucket()).file(path).download()
      return buffer
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  /**
   * `createReadStream` — the object's body as a Node readable. The caller must
   * consume or destroy it.
   *
   * Unlike the other drivers, GCS only discovers a missing object once the
   * download starts, so {@link StorageFileNotFoundError} arrives as an `error`
   * on the returned stream rather than as a rejected promise.
   */
  async getStream(path: string): Promise<Readable> {
    const file = (await this.bucket()).file(path)
    if (!file.createReadStream) {
      throw new GetStreamUnsupportedError(this.name, 'The injected GCS client does not implement createReadStream().')
    }
    return Readable.from(translateNotFound(file.createReadStream(), path))
  }

  /** `file.copy()` — GCS rewrites the object server-side; the bytes never reach this process. */
  async copy(from: string, to: string, options?: CopyDriverOptions): Promise<void> {
    const bucket = await this.bucket()
    const source = bucket.file(from)
    if (!source.copy) {
      throw new CopyUnsupportedError(this.name, 'The injected GCS client does not implement file.copy().')
    }
    try {
      await source.copy(
        bucket.file(to),
        options?.contentType !== undefined ? { metadata: { contentType: options.contentType } } : {},
      )
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(from)
      throw error
    }
  }

  /** `getMetadata()` — size, content type, etag and last-modified without a download. */
  async stat(path: string): Promise<StorageStat> {
    const file = (await this.bucket()).file(path)
    if (!file.getMetadata) {
      throw new StatUnsupportedError(this.name, 'The injected GCS client does not implement getMetadata().')
    }
    try {
      const [metadata] = await file.getMetadata()
      return {
        size: Number(metadata.size ?? 0),
        ...(metadata.contentType !== undefined ? { contentType: metadata.contentType } : {}),
        ...(metadata.etag !== undefined ? { etag: metadata.etag } : {}),
        ...(metadata.updated !== undefined ? { lastModified: new Date(metadata.updated) } : {}),
      }
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  async exists(path: string): Promise<boolean> {
    const [exists] = await (await this.bucket()).file(path).exists()
    return exists
  }

  async delete(path: string): Promise<boolean> {
    if (!(await this.exists(path))) return false
    await (await this.bucket()).file(path).delete()
    return true
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await (await this.bucket()).getFiles({ prefix })
    return files.map((file) => file.name)
  }

  async temporaryUrl(path: string, expiresInMs: number, options?: TemporaryUrlOptions): Promise<string> {
    if (options?.endpoint !== undefined) throw new TemporaryUrlUnsupportedError(this.name, ENDPOINT_UNSUPPORTED)
    const [url] = await (await this.bucket()).file(path).getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInMs,
      // Signed response header: uploaded HTML/SVG downloads instead of
      // rendering on the storage origin ('attachment' is the Disk default).
      responseDisposition: options?.disposition ?? 'attachment',
    })
    return url
  }

  /**
   * Pre-signed direct upload: a V4 signed URL with action 'write'. The
   * Content-Type is signed, and a declared `contentLength` is signed as
   * `x-goog-content-length-range: n,n`, so GCS rejects any other type or size.
   * `checksumSha256` is refused: GCS verifies MD5/CRC32C, not SHA-256.
   */
  async temporaryUploadUrl(
    path: string,
    expiresInMs: number,
    options: TemporaryUploadUrlDriverOptions,
  ): Promise<TemporaryUploadUrl> {
    if (options.endpoint !== undefined) throw new TemporaryUploadUrlUnsupportedError(this.name, ENDPOINT_UNSUPPORTED)
    if (options.checksumSha256 !== undefined) {
      throw new TemporaryUploadUrlUnsupportedError(
        this.name,
        'The "gcs" driver cannot bind checksumSha256 into a signed upload URL (GCS verifies MD5/CRC32C only). ' +
          'Omit it and verify the object after upload.',
      )
    }
    const expires = Date.now() + expiresInMs
    const lengthHeaders: Record<string, string> =
      options.contentLength !== undefined
        ? { 'x-goog-content-length-range': `${options.contentLength},${options.contentLength}` }
        : {}
    const [url] = await (await this.bucket()).file(path).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType: options.contentType,
      ...(options.contentLength !== undefined ? { extensionHeaders: lengthHeaders } : {}),
    })
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType, ...lengthHeaders },
      expiresAt: new Date(expires),
    }
  }

  async disconnect(): Promise<void> {}

  private bucket(): Promise<GcsBucketLike> {
    if (!this.bucketPromise) {
      this.bucketPromise = this.options.client
        ? Promise.resolve(this.options.client)
        : (async () => {
            const specifier = '@google-cloud/storage'
            const mod = (await import(specifier)) as {
              Storage: new (config: { projectId?: string; keyFilename?: string }) => {
                bucket(name: string): GcsBucketLike
              }
            }
            const storage = new mod.Storage({
              ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
              ...(this.options.keyFilename ? { keyFilename: this.options.keyFilename } : {}),
            })
            return storage.bucket(this.options.bucket)
          })()
    }
    return this.bucketPromise
  }
}
