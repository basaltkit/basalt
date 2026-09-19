import { BasaltError } from '@basaltkit/core'

export class StorageFileNotFoundError extends BasaltError {
  constructor(path: string) {
    super('STORAGE_FILE_NOT_FOUND', `File not found: "${path}"`)
  }
}

export class StorageInvalidPathError extends BasaltError {
  constructor(path: string) {
    super(
      'STORAGE_INVALID_PATH',
      `Invalid storage path: "${path}". Paths must stay inside the disk root.`,
    )
  }
}

export class StorageInvalidKeyError extends BasaltError {
  constructor(key: string) {
    super(
      'STORAGE_INVALID_KEY',
      `Invalid storage key: "${key}". Keys may not start with "/" or "\\", ` +
        `contain ".." path segments, or include NUL/control characters.`,
    )
  }
}

export class StorageTooLargeError extends BasaltError {
  constructor(bytes: number, maxBytes: number) {
    super(
      'STORAGE_TOO_LARGE',
      `Upload is ${bytes} bytes, exceeding the configured ${maxBytes}-byte limit.`,
    )
  }
}

export class StorageContentTypeError extends BasaltError {
  constructor(contentType: string | undefined, allowed: readonly string[]) {
    super(
      'STORAGE_CONTENT_TYPE',
      `Content type ${contentType ? `"${contentType}"` : '(none provided)'} is not allowed. ` +
        `Allowed types: ${allowed.join(', ')}.`,
    )
  }
}

export class UnknownDiskError extends BasaltError {
  constructor(disk: string) {
    super(
      'STORAGE_UNKNOWN_DISK',
      `Unknown disk "${disk}". Declare it in storagePlugin({ disks: { ... } }).`,
    )
  }
}

export class TemporaryUrlUnsupportedError extends BasaltError {
  constructor(driver: string) {
    super(
      'STORAGE_TEMPORARY_URL_UNSUPPORTED',
      `The "${driver}" driver does not support temporary URLs. Use an S3-compatible disk.`,
    )
  }
}

export class TemporaryUploadUrlUnsupportedError extends BasaltError {
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_UPLOAD_URL_UNSUPPORTED',
      detail ??
        `The "${driver}" driver does not support pre-signed upload URLs. Use an S3, Azure or GCS disk, or upload through the server with disk.put().`,
    )
  }
}

/**
 * The options passed to `temporaryUploadUrl` cannot be signed safely: missing
 * or malformed content type, a non-integer length, a malformed checksum, or a
 * `maxBytes` cap without a declared `contentLength`. 400: the caller chose them.
 */
export class StorageUploadUrlInvalidError extends BasaltError {
  readonly status = 400
  constructor(reason: string) {
    super('STORAGE_UPLOAD_URL_INVALID', `Invalid pre-signed upload request: ${reason}`)
  }
}

export class ImageProcessingUnavailableError extends BasaltError {
  constructor(
    detail = 'No image processor configured. Install @basaltkit/image-sharp and pass it to storagePlugin({ imageProcessor }).',
  ) {
    super('STORAGE_IMAGE_UNAVAILABLE', detail)
  }
}

/**
 * A tenant-scoped disk ran without a tenant in context while tenancy is
 * active. Fails closed: the alternative is resolving the caller's key against
 * the bucket root, where every tenant's `tenants/<id>/` tree lives. 400, the
 * same contract as `TenantRequiredError`.
 */
export class StorageTenantRequiredError extends BasaltError {
  readonly status = 400
  constructor(disk: string) {
    super(
      'STORAGE_TENANT_REQUIRED',
      `Refusing storage operation on disk "${disk}": it is tenant-scoped and no tenant is in context. ` +
        "Establish a tenant, or give a deliberately central disk scope: null or onMissingScope: 'root'.",
    )
  }
}

/**
 * The resolved scope prefix is not a safe path prefix — for the default scope,
 * a tenant id that is not a single path segment (`..`, `a/b`, control
 * characters). Refused so a tenant id can never address another tenant's tree
 * or the bucket root.
 */
export class StorageInvalidScopeError extends BasaltError {
  constructor() {
    super(
      'STORAGE_INVALID_SCOPE',
      'Invalid storage scope: the tenant id (or custom scope) is not a safe path prefix. ' +
        'Scope segments may not be empty, ".", "..", contain "/" or "\\", or include control characters.',
    )
  }
}

/** A temporary URL lifetime outside (0, maxTemporaryUrlTtl]. 400: the caller chose it. */
export class TemporaryUrlTtlTooLongError extends BasaltError {
  readonly status = 400
  constructor(requestedMs: number, maxMs: number) {
    super(
      'STORAGE_TEMPORARY_URL_TTL',
      `Temporary URL lifetime ${requestedMs}ms is not allowed: it must be greater than 0 and at most ${maxMs}ms.`,
    )
  }
}
