import {
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
  type TemporaryUrlOptions,
  StorageFileNotFoundError,
  TemporaryUploadUrlUnsupportedError,
  type PutOptions,
  type StorageDriver,
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

/** The subset of a `@google-cloud/storage` File this driver uses. */
export interface GcsFileLike {
  save(data: Buffer, options?: { contentType?: string }): Promise<unknown>
  download(): Promise<[Buffer]>
  exists(): Promise<[boolean]>
  delete(): Promise<unknown>
  getSignedUrl(config: GcsSignedUrlConfig): Promise<[string]>
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

const isNotFound = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 404

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

  async get(path: string): Promise<Buffer> {
    try {
      const [buffer] = await (await this.bucket()).file(path).download()
      return buffer
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
