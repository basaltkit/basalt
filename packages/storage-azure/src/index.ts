import { StorageFileNotFoundError, type PutOptions, type StorageDriver } from '@machize/storage'

/** The subset of an `@azure/storage-blob` BlockBlobClient this driver uses. */
export interface AzureBlobLike {
  uploadData(data: Buffer, options?: { blobHTTPHeaders?: { blobContentType?: string } }): Promise<unknown>
  downloadToBuffer(): Promise<Buffer>
  exists(): Promise<boolean>
  deleteIfExists(): Promise<{ succeeded: boolean }>
  generateSasUrl(options: { permissions: string; expiresOn: Date }): Promise<string>
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

const isNotFound = (error: unknown): boolean =>
  (error as { statusCode?: number; code?: string } | undefined)?.statusCode === 404 ||
  (error as { code?: string } | undefined)?.code === 'BlobNotFound'

/**
 * Azure Blob Storage driver for `@machize/storage`. Uses `@azure/storage-blob`
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

  async get(path: string): Promise<Buffer> {
    try {
      return await (await this.container()).getBlockBlobClient(path).downloadToBuffer()
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

  async temporaryUrl(path: string, expiresInMs: number): Promise<string> {
    return (await this.container())
      .getBlockBlobClient(path)
      .generateSasUrl({ permissions: 'r', expiresOn: new Date(Date.now() + expiresInMs) })
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
