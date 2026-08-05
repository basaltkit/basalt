import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { StorageFileNotFoundError } from '../errors.js'
import type { PutOptions, StorageDriver } from '../driver.js'

export interface S3DriverOptions {
  bucket: string
  region?: string
  /** Custom endpoint — set this to use MinIO or any S3-compatible service. */
  endpoint?: string
  credentials?: { accessKeyId: string; secretAccessKey: string }
  /**
   * Path-style URLs (http://host/bucket/key) instead of virtual-hosted style.
   * Defaults to true when an endpoint is set (required by MinIO).
   */
  forcePathStyle?: boolean
}

/** S3-compatible driver — works with AWS S3, MinIO, Cloudflare R2, etc. */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3'
  private readonly client: S3Client
  private readonly bucket: string

  constructor(options: S3DriverOptions) {
    this.bucket = options.bucket
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
    })
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: content,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
      }),
    )
  }

  async get(path: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      )
      const bytes = await response.Body?.transformToByteArray()
      return Buffer.from(bytes ?? [])
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }))
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  async delete(path: string): Promise<boolean> {
    const existed = await this.exists(path)
    if (existed) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }))
    }
    return existed
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      )
      for (const object of response.Contents ?? []) {
        if (object.Key) keys.push(object.Key)
      }
      continuationToken = response.NextContinuationToken
    } while (continuationToken)
    return keys.sort()
  }

  async temporaryUrl(path: string, expiresInMs: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      { expiresIn: Math.max(1, Math.ceil(expiresInMs / 1000)) },
    )
  }

  async disconnect(): Promise<void> {
    this.client.destroy()
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}
