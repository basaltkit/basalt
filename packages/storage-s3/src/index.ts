import { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  StorageFileNotFoundError,
  StorageStreamLengthRequiredError,
  type CopyDriverOptions,
  type DiskOptions,
  type PutOptions,
  type PutStreamOptions,
  type StorageDriver,
  type StorageStat,
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
  type TemporaryUrlOptions,
} from '@basaltkit/storage'

/**
 * Server-side encryption applied by the driver. `'AES256'` is SSE-S3
 * (S3-managed keys); `{ kms }` is SSE-KMS with the given key id / ARN / alias.
 */
export type S3ServerSideEncryption = 'AES256' | { kms: string }

/**
 * S3's multipart floor: every part but the last must be at least 5 MiB, so a
 * smaller `partSizeBytes` is rejected rather than discovered on the wire.
 */
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024

/** Parts uploaded in parallel by default — small enough to stay cheap in memory. */
const DEFAULT_QUEUE_SIZE = 4

/**
 * Multipart knobs. Settable on the driver (a default for every upload) and per
 * {@link S3StorageDriver.putStream} call, which wins.
 */
export interface S3MultipartOptions {
  /**
   * Bytes per part. Defaults to 5 MiB — S3's minimum for every part but the
   * last, and therefore the lowest value accepted. Larger parts mean fewer
   * requests and more memory: up to `partSizeBytes × queueSize` is in flight.
   */
  partSizeBytes?: number
  /** Parts uploaded in parallel. Defaults to 4. Must be at least 1. */
  queueSize?: number
}

/** What {@link S3StorageDriver.putStream} accepts — the shared options plus the multipart knobs. */
export interface S3PutStreamOptions extends PutStreamOptions, S3MultipartOptions {}

export interface S3DriverOptions extends S3MultipartOptions {
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
  /**
   * Server-side encryption sent with every put and signed into every
   * pre-signed upload URL. Unset: no SSE headers are sent and the bucket's
   * default encryption applies — configuring default encryption on the bucket
   * is the simplest alternative (and AWS encrypts new objects with SSE-S3 by
   * default). Set `{ kms }` when objects must use a specific KMS key.
   */
  serverSideEncryption?: S3ServerSideEncryption
  /**
   * Default base endpoint for pre-signed URLs, when the host that SERVES the
   * bucket differs from the one this process talks to. The classic split: the
   * API reaches MinIO at `http://minio:9000` inside the container network
   * while browsers and isolated workers must use the public name.
   *
   * Applies to `temporaryUrl` and `temporaryUploadUrl`; a per-call `endpoint`
   * wins over it. Region, path style, credentials and SSE are unchanged — only
   * the host the signature is computed for. Point it at the SAME bucket under
   * another name; never at a third party.
   */
  signingEndpoint?: string
}

/** Every S3DriverOptions key — `s3Disk` splits driver options from disk options with it. */
const S3_DRIVER_OPTION_KEYS = {
  bucket: true,
  region: true,
  endpoint: true,
  credentials: true,
  forcePathStyle: true,
  serverSideEncryption: true,
  signingEndpoint: true,
  partSizeBytes: true,
  queueSize: true,
} satisfies Record<keyof S3DriverOptions, true>

const sseInput = (sse: S3ServerSideEncryption | undefined) =>
  sse === undefined
    ? {}
    : sse === 'AES256'
      ? { ServerSideEncryption: 'AES256' as const }
      : { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: sse.kms }

const sseHeaders = (sse: S3ServerSideEncryption | undefined): Record<string, string> =>
  sse === undefined
    ? {}
    : sse === 'AES256'
      ? { 'x-amz-server-side-encryption': 'AES256' }
      : { 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': sse.kms }

/** The `Upload` instance `@aws-sdk/lib-storage` hands back. */
interface MultipartUpload {
  done(): Promise<unknown>
  abort(): Promise<unknown>
}

/**
 * The slice of `@aws-sdk/lib-storage` this driver uses, described structurally
 * so the package is never a build-time dependency either — nothing here needs
 * its types to compile.
 */
interface MultipartUploadConstructor {
  new (options: {
    client: S3Client
    params: Record<string, unknown>
    partSize?: number
    queueSize?: number
    leavePartsOnError?: boolean
  }): MultipartUpload
}

/** Resolved once per process: the constructor, or `null` when the package is not installed. */
let libStorage: Promise<MultipartUploadConstructor | null> | undefined

/**
 * "This package is not installed", told apart from every other load failure.
 *
 * Node throws `ERR_MODULE_NOT_FOUND`; loaders and bundlers (vitest, ts-node,
 * webpack) re-throw their own error with the original on `cause`, so the chain
 * is walked — bounded, because a `cause` cycle is not impossible.
 */
function isModuleNotFound(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Loads `@aws-sdk/lib-storage` on first use.
 *
 * The import is dynamic and lives here, in the only code path that needs it:
 * importing this module never touches it, so apps that do not install the
 * optional peer are unaffected. A missing package resolves to `null`; any
 * OTHER failure (a broken install, a module that throws while loading) is
 * rethrown rather than quietly degraded into "multipart unavailable".
 */
async function loadMultipartUpload(): Promise<MultipartUploadConstructor | null> {
  libStorage ??= import('@aws-sdk/lib-storage').then(
    (module) => {
      const Upload = (module as unknown as { Upload?: MultipartUploadConstructor }).Upload
      if (typeof Upload !== 'function') {
        throw new TypeError('@aws-sdk/lib-storage is installed but does not export `Upload`; check the installed version.')
      }
      return Upload
    },
    (error: unknown) => {
      if (isModuleNotFound(error)) return null
      throw error
    },
  )
  try {
    return await libStorage
  } catch (error) {
    // Never cache a hard failure: a later call gets a real attempt again.
    libStorage = undefined
    throw error
  }
}

function assertPartSize(value: number): number {
  if (!Number.isInteger(value) || value < S3_MIN_PART_SIZE_BYTES) {
    throw new RangeError(
      `partSizeBytes must be an integer of at least ${S3_MIN_PART_SIZE_BYTES} bytes (S3's 5 MiB minimum part size); received ${value}.`,
    )
  }
  return value
}

function assertQueueSize(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`queueSize must be an integer of at least 1; received ${value}.`)
  }
  return value
}

/** S3-compatible driver — works with AWS S3, MinIO, Cloudflare R2, etc. */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3'
  private readonly client: S3Client
  private readonly bucket: string
  private readonly serverSideEncryption: S3ServerSideEncryption | undefined
  private readonly clientConfig: S3ClientConfig
  private readonly signingEndpoint: string | undefined
  private readonly partSizeBytes: number
  private readonly queueSize: number
  /** Presigning clients, keyed by the endpoint they sign for ('' = the driver's own). */
  private readonly signers = new Map<string, { download: S3Client; upload: S3Client }>()

  constructor(options: S3DriverOptions) {
    this.bucket = options.bucket
    this.serverSideEncryption = options.serverSideEncryption
    this.signingEndpoint = options.signingEndpoint
    // Validated here so a misconfigured disk fails at boot, not on the first
    // large upload hours later.
    this.partSizeBytes = options.partSizeBytes === undefined ? S3_MIN_PART_SIZE_BYTES : assertPartSize(options.partSizeBytes)
    this.queueSize = options.queueSize === undefined ? DEFAULT_QUEUE_SIZE : assertQueueSize(options.queueSize)
    this.clientConfig = {
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
    }
    this.client = new S3Client(this.clientConfig)
  }

  /**
   * Clients used only to presign, one pair per signing endpoint.
   *
   * The `upload` one exists because with the SDK default
   * (`requestChecksumCalculation: 'WHEN_SUPPORTED'`) a presigned PutObject
   * carries the CRC32 of the EMPTY body it was signed with
   * (`x-amz-checksum-crc32=AAAAAA==`), so every real upload would fail its
   * integrity check. Uploads presigned here compute no checksum of their own;
   * integrity comes from the caller's `checksumSha256` when given.
   *
   * An `endpoint` override only changes the host the signature is computed
   * for: region, path style, credentials and SSE come from the same config, so
   * the URL addresses the same bucket under another name.
   */
  private signer(endpoint: string | undefined): { download: S3Client; upload: S3Client } {
    const target = endpoint ?? this.signingEndpoint
    const key = target ?? ''
    let pair = this.signers.get(key)
    if (!pair) {
      const config: S3ClientConfig = target === undefined ? this.clientConfig : { ...this.clientConfig, endpoint: target }
      pair = {
        download: target === undefined ? this.client : new S3Client(config),
        upload: new S3Client({ ...config, requestChecksumCalculation: 'WHEN_REQUIRED' }),
      }
      this.signers.set(key, pair)
    }
    return pair
  }

  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: content,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
        ...sseInput(this.serverSideEncryption),
      }),
    )
  }

  /**
   * Streams a body into S3.
   *
   * `PutObject` cannot send a body of unknown length in a single request, so
   * the route depends on what the caller knows:
   *
   * - `contentLength` is known — the stream goes straight to `PutObject`,
   *   nothing is buffered (this is what `files.upload()` does when the client
   *   sends a `Content-Length`);
   * - `maxBytes` is set — the body is buffered up to that cap and sent as one
   *   object (bounded memory, chosen deliberately);
   * - neither — multipart upload, when the optional peer
   *   `@aws-sdk/lib-storage` is installed: the body is uploaded part by part,
   *   unbounded, holding only `partSizeBytes × queueSize` at a time. Without
   *   that package the call still fails with
   *   {@link StorageStreamLengthRequiredError}, which now names it.
   */
  async putStream(path: string, source: Readable, options: S3PutStreamOptions): Promise<void> {
    if (options.contentLength === undefined && options.maxBytes === undefined) {
      return this.putMultipart(path, source, options)
    }
    // With a known length the stream is forwarded as-is; without one it is
    // collected under the cap the caller accepted.
    const body = options.contentLength !== undefined ? source : await collect(source)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: body,
        ...(options.contentLength !== undefined
          ? { ContentLength: options.contentLength }
          : { ContentLength: (body as Buffer).byteLength }),
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...sseInput(this.serverSideEncryption),
      }),
    )
  }

  /**
   * Multipart upload of a stream whose length nobody knows, through
   * `@aws-sdk/lib-storage`.
   *
   * The same `Key` (already tenant-scoped by the Disk), `ContentType` and
   * server-side encryption a `PutObject` would carry are sent on
   * `CreateMultipartUpload`, so a multipart object is stored exactly like a
   * single-shot one. A failure — including the facade's `maxBytes` cap firing
   * mid-stream — aborts the upload so S3 keeps no incomplete parts, which are
   * invisible in listings and billed until removed.
   */
  private async putMultipart(path: string, source: Readable, options: S3PutStreamOptions): Promise<void> {
    // Validated before anything is loaded or read: a bad part size is a
    // configuration bug and should say so whatever else is installed.
    const partSize = options.partSizeBytes === undefined ? this.partSizeBytes : assertPartSize(options.partSizeBytes)
    const queueSize = options.queueSize === undefined ? this.queueSize : assertQueueSize(options.queueSize)
    const Upload = await loadMultipartUpload()
    if (Upload === null) {
      source.destroy()
      throw new StorageStreamLengthRequiredError(
        this.name,
        'S3 PutObject cannot send a body of unknown length. Pass contentLength when you know it, or maxBytes to buffer up to a cap; ' +
          'install the optional peer @aws-sdk/lib-storage to stream bodies of any size (multipart upload).',
      )
    }
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: path,
        Body: source,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
        ...sseInput(this.serverSideEncryption),
      },
      partSize,
      queueSize,
      leavePartsOnError: false,
    })
    try {
      await upload.done()
    } catch (error) {
      // lib-storage already aborts on its own failures; this covers the rest
      // (and is cheap). Belt and braces: an `AbortIncompleteMultipartUpload`
      // lifecycle rule on the bucket sweeps up whatever no process got to.
      await upload.abort().catch(() => undefined)
      if (!source.destroyed) source.destroy()
      throw error
    }
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

  /** The `GetObject` body, as a Node `Readable`. The caller must consume or destroy it. */
  async getStream(path: string): Promise<Readable> {
    let body: unknown
    try {
      body = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }))).Body
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(path)
      throw error
    }
    if (body === undefined || body === null) throw new StorageFileNotFoundError(path)
    // Node: an IncomingMessage (already a Readable). Other runtimes hand back a
    // web ReadableStream; anything else that iterates is wrapped as-is.
    if (body instanceof Readable) return body
    if (typeof (body as { getReader?: unknown }).getReader === 'function') {
      return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    }
    return Readable.from(body as AsyncIterable<Uint8Array>)
  }

  /** `CopyObject`: S3 moves the bytes, they never reach this process. */
  async copy(from: string, to: string, options?: CopyDriverOptions): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: to,
          // Must be URL-encoded; keys with spaces or '+' break otherwise.
          CopySource: encodeURIComponent(`${this.bucket}/${from}`),
          ...(options?.contentType ? { ContentType: options.contentType, MetadataDirective: 'REPLACE' as const } : {}),
          ...sseInput(this.serverSideEncryption),
        }),
      )
    } catch (error) {
      if (isNotFound(error)) throw new StorageFileNotFoundError(from)
      throw error
    }
  }

  /** `HeadObject`: size, content type, etag and last-modified without a download. */
  async stat(path: string): Promise<StorageStat> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }))
      return {
        size: head.ContentLength ?? 0,
        ...(head.ContentType !== undefined ? { contentType: head.ContentType } : {}),
        ...(head.ETag !== undefined ? { etag: head.ETag } : {}),
        ...(head.LastModified !== undefined ? { lastModified: head.LastModified } : {}),
      }
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

  async temporaryUrl(path: string, expiresInMs: number, options?: TemporaryUrlOptions): Promise<string> {
    return getSignedUrl(
      this.signer(options?.endpoint).download,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: path,
        // 'attachment' (the Disk-layer default) keeps uploaded HTML/SVG from
        // rendering top-level on the bucket/CDN origin.
        ResponseContentDisposition: options?.disposition ?? 'attachment',
      }),
      { expiresIn: Math.max(1, Math.ceil(expiresInMs / 1000)) },
    )
  }

  /**
   * Pre-signed PutObject. Content-Type — and Content-Length, the SHA-256
   * checksum and the SSE headers when present — are signed as HEADERS (not
   * hoisted into the query string), so S3 rejects an upload that omits or
   * changes any of them: the client cannot swap the type, grow the body or
   * skip encryption. With `checksumSha256`, S3 also verifies the body itself.
   */
  async temporaryUploadUrl(
    path: string,
    expiresInMs: number,
    options: TemporaryUploadUrlDriverOptions,
  ): Promise<TemporaryUploadUrl> {
    const expiresIn = Math.max(1, Math.ceil(expiresInMs / 1000))
    const url = await getSignedUrl(
      this.signer(options.endpoint).upload,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        ContentType: options.contentType,
        ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
        ...(options.checksumSha256 !== undefined ? { ChecksumSHA256: options.checksumSha256 } : {}),
        ...sseInput(this.serverSideEncryption),
      }),
      {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set([
          'x-amz-checksum-sha256',
          'x-amz-server-side-encryption',
          'x-amz-server-side-encryption-aws-kms-key-id',
        ]),
      },
    )
    return {
      url,
      method: 'PUT',
      headers: {
        'Content-Type': options.contentType,
        ...(options.contentLength !== undefined ? { 'Content-Length': String(options.contentLength) } : {}),
        ...(options.checksumSha256 !== undefined ? { 'x-amz-checksum-sha256': options.checksumSha256 } : {}),
        ...sseHeaders(this.serverSideEncryption),
      },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    }
  }

  async disconnect(): Promise<void> {
    this.client.destroy()
    for (const pair of this.signers.values()) {
      if (pair.download !== this.client) pair.download.destroy()
      pair.upload.destroy()
    }
    this.signers.clear()
  }
}

/** Reads a readable into one Buffer. Only used where S3 needs a known length. */
async function collect(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}

/**
 * An S3 disk, ready to hand to `storagePlugin({ disks })`.
 *
 * ```ts
 * storagePlugin({
 *   disks: {
 *     documents: s3Disk({ bucket: 'docs', region: 'eu-west-1' }),
 *     uploads: s3Disk({ bucket: 'up', endpoint: 'http://localhost:9000' }), // MinIO
 *   },
 * })
 * ```
 *
 * This is the shape `@basaltkit/storage-azure` and `@basaltkit/storage-gcs`
 * already use — a driver instance, not a string. The `{ driver: 's3' }`
 * shorthand it replaces lived in the core, which meant every consumer installed
 * the AWS SDK (4.4 MB) whether or not they used S3.
 */
export function s3Disk(options: S3DriverOptions & DiskOptions): { driver: S3StorageDriver } & DiskOptions {
  // Split by the driver's own key list, so EVERY disk option (scope,
  // onMissingScope, maxTemporaryUrlTtl, ... and any added later) reaches the
  // Disk. It used to forward `scope` only, silently dropping security options.
  const driverOptions: Record<string, unknown> = {}
  const diskOptions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    if (Object.hasOwn(S3_DRIVER_OPTION_KEYS, key)) driverOptions[key] = value
    else diskOptions[key] = value
  }
  return {
    driver: new S3StorageDriver(driverOptions as unknown as S3DriverOptions),
    ...(diskOptions as DiskOptions),
  }
}
