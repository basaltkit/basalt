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
  temporaryUrl?(path: string, expiresInMs: number): Promise<string>
  disconnect(): Promise<void>
}
