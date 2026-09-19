import { Readable } from 'node:stream'
import {
  DEFAULT_MAX_TEMPORARY_URL_TTL,
  type TemporaryUrlOptions,
  CopyUnsupportedError,
  GetStreamUnsupportedError,
  PutStreamUnsupportedError,
  StatUnsupportedError,
  StorageFileNotFoundError,
  TemporaryUploadUrlUnsupportedError,
  TemporaryUrlTtlTooLongError,
  TemporaryUrlUnsupportedError,
  type CopyDriverOptions,
  type PutOptions,
  type PutStreamOptions,
  type StorageDriver,
  type StorageStat,
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
} from '@basaltkit/storage'

/** What `getProperties()` returns, in the shape this driver reads. */
export interface AzureBlobProperties {
  contentLength?: number
  contentType?: string
  etag?: string
  lastModified?: Date
}

/** The subset of an `@azure/storage-blob` BlockBlobClient this driver uses. */
export interface AzureBlobLike {
  uploadData(data: Buffer, options?: { blobHTTPHeaders?: { blobContentType?: string } }): Promise<unknown>
  downloadToBuffer(): Promise<Buffer>
  exists(): Promise<boolean>
  deleteIfExists(): Promise<{ succeeded: boolean }>
  generateSasUrl(options: { permissions: string; expiresOn: Date; contentDisposition?: string }): Promise<string>
  /** Block-blob streaming upload — the SDK chunks the readable for us. */
  uploadStream?(
    stream: Readable,
    bufferSize?: number,
    maxConcurrency?: number,
    options?: { blobHTTPHeaders?: { blobContentType?: string } },
  ): Promise<unknown>
  /** Streaming download; `readableStreamBody` is undefined only in the browser bundle. */
  download?(offset?: number): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>
  /** Server-side copy from a (SAS) URL, completed before it resolves. */
  syncCopyFromURL?(source: string, options?: { blobHTTPHeaders?: { blobContentType?: string } }): Promise<unknown>
  getProperties?(): Promise<AzureBlobProperties>
  readonly url?: string
}

/** The subset of an `@azure/storage-blob` ContainerClient this driver uses. */
export interface AzureContainerLike {
  getBlockBlobClient(path: string): AzureBlobLike
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>
}

export interface AzureDriverOptions {
  container: string
  connectionString?: string
  /** Injectable container — defaults to `@azure/storage-blob`. Tests pass a fake. */
  client?: AzureContainerLike
}

/**
 * Azure derives a SAS URL from the blob client's own account host, and the
 * SDK exposes no way to sign for another one, so an endpoint override is
 * refused instead of silently ignored (which would mint a URL for the wrong
 * host). Reach the account under another name with a custom DNS alias on the
 * storage account, or build the client with that endpoint.
 */
const ENDPOINT_UNSUPPORTED =
  'The "azure" driver cannot sign a SAS URL for a different endpoint: the SDK derives it from the blob client\'s account host. ' +
  'Configure the driver with a connection string for that endpoint instead.'

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number; code?: string } | undefined)?.statusCode === 404 ||
  (error as { code?: string } | undefined)?.code === 'BlobNotFound'

/**
 * Azure Blob Storage driver for `@basaltkit/storage`. Uses `@azure/storage-blob`
 * (an optional peer dependency) via an injectable container client, so its
 * logic is unit-tested without touching Azure.
 */
export class AzureBlobStorageDriver implements StorageDriver {
  readonly name = 'azure'
  private containerPromise: Promise<AzureContainerLike> | undefined

  constructor(private readonly options: AzureDriverOptions) {}

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content)
    await (await this.container())
      .getBlockBlobClient(path)
      .uploadData(data, options?.contentType !== undefined ? { blobHTTPHeaders: { blobContentType: options.contentType } } : {})
  }

  /**
   * `uploadStream` — the SDK splits the readable into blocks, so a body of any
   * size (and of unknown length) is uploaded without ever being held whole.
   */
  async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> {
    const blob = (await this.container()).getBlockBlobClient(path)
    if (!blob.uploadStream) {
      throw new PutStreamUnsupportedError(this.name, 'The injected Azure client does not implement uploadStream().')
    }
    await blob.uploadStream(
      source,
      undefined,
      undefined,
      options.contentType !== undefined ? { blobHTTPHeaders: { blobContentType: options.contentType } } : {},
    )
  }

  async get(path: string): Promise<Buffer> {
    try {
      return await (await this.container()).getBlockBlobClient(path).downloadToBuffer()
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  /** `download()` — the blob's body as a Node readable. The caller must consume or destroy it. */
  async getStream(path: string): Promise<Readable> {
    const blob = (await this.container()).getBlockBlobClient(path)
    if (!blob.download) {
      throw new GetStreamUnsupportedError(this.name, 'The injected Azure client does not implement download().')
    }
    let body: NodeJS.ReadableStream | undefined
    try {
      body = (await blob.download()).readableStreamBody
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
    if (!body) throw new StorageFileNotFoundError(path)
    return body instanceof Readable ? body : Readable.from(body as AsyncIterable<Uint8Array>)
  }

  /**
   * Server-side copy: the destination blob pulls the source through a
   * short-lived read SAS, so the bytes never reach this process.
   *
   * `syncCopyFromURL` (Copy Blob From URL) completes before it resolves and is
   * limited to 256 MiB by Azure; copy larger blobs with `beginCopyFromURL` on
   * the SDK client directly, or stream them with `getStream`/`putStream`.
   */
  async copy(from: string, to: string, options?: CopyDriverOptions): Promise<void> {
    const container = await this.container()
    const target = container.getBlockBlobClient(to)
    if (!target.syncCopyFromURL) {
      throw new CopyUnsupportedError(this.name, 'The injected Azure client does not implement syncCopyFromURL().')
    }
    const source = container.getBlockBlobClient(from)
    if (!(await source.exists())) throw new StorageFileNotFoundError(from)
    // Copy Blob From URL needs a readable URL for the source; a 5-minute read
    // SAS is the narrowest credential that gives it one.
    const url = await source.generateSasUrl({ permissions: 'r', expiresOn: new Date(Date.now() + 5 * 60 * 1000) })
    await target.syncCopyFromURL(
      url,
      options?.contentType !== undefined ? { blobHTTPHeaders: { blobContentType: options.contentType } } : {},
    )
  }

  /** `getProperties()` — size, content type, etag and last-modified without a download. */
  async stat(path: string): Promise<StorageStat> {
    const blob = (await this.container()).getBlockBlobClient(path)
    if (!blob.getProperties) {
      throw new StatUnsupportedError(this.name, 'The injected Azure client does not implement getProperties().')
    }
    try {
      const properties = await blob.getProperties()
      return {
        size: properties.contentLength ?? 0,
        ...(properties.contentType !== undefined ? { contentType: properties.contentType } : {}),
        ...(properties.etag !== undefined ? { etag: properties.etag } : {}),
        ...(properties.lastModified !== undefined ? { lastModified: properties.lastModified } : {}),
      }
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.container()).getBlockBlobClient(path).exists()
  }

  async delete(path: string): Promise<boolean> {
    const result = await (await this.container()).getBlockBlobClient(path).deleteIfExists()
    return result.succeeded
  }

  async list(prefix: string): Promise<string[]> {
    const names: string[] = []
    for await (const blob of (await this.container()).listBlobsFlat({ prefix })) names.push(blob.name)
    return names
  }

  async temporaryUrl(path: string, expiresInMs: number, options?: TemporaryUrlOptions): Promise<string> {
    // Azure service SAS has no native maximum lifetime (unlike S3/GCS V4
    // signatures, capped at 7 days), so the driver enforces the same ceiling
    // itself — also when called directly, not only through the Disk facade.
    if (!(expiresInMs > 0) || expiresInMs > DEFAULT_MAX_TEMPORARY_URL_TTL) {
      throw new TemporaryUrlTtlTooLongError(expiresInMs, DEFAULT_MAX_TEMPORARY_URL_TTL)
    }
    if (options?.endpoint !== undefined) throw new TemporaryUrlUnsupportedError(this.name, ENDPOINT_UNSUPPORTED)
    return (await this.container()).getBlockBlobClient(path).generateSasUrl({
      permissions: 'r',
      expiresOn: new Date(Date.now() + expiresInMs),
      // SAS-pinned response header: uploaded HTML/SVG downloads instead of
      // rendering on the storage origin ('attachment' is the Disk default).
      contentDisposition: options?.disposition ?? 'attachment',
    })
  }

  /**
   * Pre-signed direct upload: a service SAS with create + write permission
   * only (no read/list/delete), valid for `expiresInMs`.
   *
   * Caveat: an Azure SAS cannot bind request headers, so — unlike S3 and GCS —
   * the declared Content-Type and Content-Length are NOT enforced by the
   * signature. They are returned as the headers the client should send; treat
   * the upload as untrusted and verify the blob's properties (type, size)
   * before using it. `checksumSha256` is refused: Put Blob has no SHA-256
   * header to carry it.
   */
  async temporaryUploadUrl(
    path: string,
    expiresInMs: number,
    options: TemporaryUploadUrlDriverOptions,
  ): Promise<TemporaryUploadUrl> {
    // Same driver-level ceiling as temporaryUrl: Azure SAS has no native maximum.
    if (!(expiresInMs > 0) || expiresInMs > DEFAULT_MAX_TEMPORARY_URL_TTL) {
      throw new TemporaryUrlTtlTooLongError(expiresInMs, DEFAULT_MAX_TEMPORARY_URL_TTL)
    }
    if (options.endpoint !== undefined) throw new TemporaryUploadUrlUnsupportedError(this.name, ENDPOINT_UNSUPPORTED)
    if (options.checksumSha256 !== undefined) {
      throw new TemporaryUploadUrlUnsupportedError(
        this.name,
        'The "azure" driver cannot bind checksumSha256 into a SAS upload URL (Put Blob verifies MD5/CRC64 only). ' +
          'Omit it and verify the blob after upload.',
      )
    }
    const expiresOn = new Date(Date.now() + expiresInMs)
    const url = await (await this.container()).getBlockBlobClient(path).generateSasUrl({ permissions: 'cw', expiresOn })
    return {
      url,
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': options.contentType,
        ...(options.contentLength !== undefined ? { 'Content-Length': String(options.contentLength) } : {}),
      },
      expiresAt: expiresOn,
    }
  }

  async disconnect(): Promise<void> {}

  private container(): Promise<AzureContainerLike> {
    if (!this.containerPromise) {
      this.containerPromise = this.options.client
        ? Promise.resolve(this.options.client)
        : (async () => {
            if (!this.options.connectionString) throw new Error('connectionString is required for the Azure driver.')
            const specifier = '@azure/storage-blob'
            const mod = (await import(specifier)) as {
              BlobServiceClient: {
                fromConnectionString(connectionString: string): { getContainerClient(name: string): AzureContainerLike }
              }
            }
            return mod.BlobServiceClient.fromConnectionString(this.options.connectionString).getContainerClient(this.options.container)
          })()
    }
    return this.containerPromise
  }
}
