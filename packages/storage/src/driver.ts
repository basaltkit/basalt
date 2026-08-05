export interface PutOptions {
  contentType?: string
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
