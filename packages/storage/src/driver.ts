export interface PutOptions {
  contentType?: string
  /**
   * Facade-enforced upload cap. When set, the facade rejects content larger
   * than this many bytes with `STORAGE_TOO_LARGE` before delegating to the
   * driver. Enforced for `Buffer`/`string` inputs, whose byte length is known
   * up front. Opt-in: with no value, uploads are uncapped as before.
   */
  maxBytes?: number
  /**
   * Facade-enforced content-type allowlist. When set, the facade rejects an
   * upload whose `contentType` is missing or not in this list with
   * `STORAGE_CONTENT_TYPE`. Opt-in: with no value, any content type is allowed.
   */
  allowedContentTypes?: readonly string[]
}

/** Storage driver contract. Every driver must pass the same conformance suite. */
export interface StorageDriver {
  /** Human-readable driver name — used in error messages. */
  readonly name: string
  put(path: string, content: Buffer | string, options?: PutOptions): Promise<void>
  /** Throws StorageFileNotFoundError when the file does not exist. */
  get(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>
  delete(path: string): Promise<boolean>
  /** Lists file paths under the given prefix. */
  list(prefix: string): Promise<string[]>
  /** Optional: pre-signed URL valid for `expiresInMs`. */
  temporaryUrl?(path: string, expiresInMs: number, options?: TemporaryUrlOptions): Promise<string>
  /**
   * Optional: pre-signed direct-upload (PUT) URL valid for `expiresInMs`. The
   * driver must bind `contentType` (and `contentLength` / `checksumSha256` when
   * given) into the signature where its backend supports it, and return every
   * header the client has to send. The Disk layer validates the key, applies
   * the tenant scope and caps the lifetime before calling this.
   */
  temporaryUploadUrl?(
    path: string,
    expiresInMs: number,
    options: TemporaryUploadUrlDriverOptions,
  ): Promise<TemporaryUploadUrl>
  disconnect(): Promise<void>
}

/**
 * How a pre-signed URL serves the object. The Disk layer always passes an
 * explicit value — 'attachment' unless the caller deliberately opts into
 * 'inline' — so a client-declared text/html or SVG object can never render
 * top-level off the bucket/CDN origin (stored-XSS vector; review 2026-08-b,
 * S-3). Embedded uses (<img>, <video>) are unaffected by disposition.
 */
export interface TemporaryUrlOptions {
  disposition?: 'attachment' | 'inline'
}

/** What a driver binds into a pre-signed upload URL. Validated by the Disk layer. */
export interface TemporaryUploadUrlDriverOptions {
  /** Always present: the only Content-Type the upload may declare. */
  contentType: string
  /** Exact body size in bytes, signed where the backend supports it. */
  contentLength?: number
  /** Base64 SHA-256 of the body, signed where the backend supports it. */
  checksumSha256?: string
}

/** A pre-signed direct upload: the client sends `method url` with exactly `headers`. */
export interface TemporaryUploadUrl {
  url: string
  method: 'PUT'
  /**
   * Headers the client MUST send verbatim (they are part of the signature, or
   * required by the backend). Adding, dropping or changing one fails the upload.
   * `Content-Length` is included when bound; browsers set it themselves from the body.
   */
  headers: Record<string, string>
  /** When the URL stops working. */
  expiresAt: Date
  /** Full object key the upload lands on, tenant prefix included. Set by the Disk layer. */
  key?: string
}
