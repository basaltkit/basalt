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
        `contain "..", "." or empty path segments (e.g. "a//b", a trailing "/"), or include NUL/control characters.`,
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
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_TEMPORARY_URL_UNSUPPORTED',
      detail ?? `The "${driver}" driver does not support temporary URLs. Use an S3-compatible disk.`,
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

/** The driver cannot stream an upload — buffer with `disk.put()` instead. */
export class PutStreamUnsupportedError extends BasaltError {
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_PUT_STREAM_UNSUPPORTED',
      detail ??
        `The "${driver}" driver does not support streaming uploads. Use disk.put() with a Buffer, or a driver that implements putStream (local, s3, azure, gcs).`,
    )
  }
}

/** The driver cannot stream a download — read it whole with `disk.get()` instead. */
export class GetStreamUnsupportedError extends BasaltError {
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_GET_STREAM_UNSUPPORTED',
      detail ??
        `The "${driver}" driver does not support streaming downloads. Use disk.get(), or a driver that implements getStream (local, s3, azure, gcs).`,
    )
  }
}

/** The driver cannot copy server-side and no streaming fallback was available. */
export class CopyUnsupportedError extends BasaltError {
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_COPY_UNSUPPORTED',
      detail ??
        `The "${driver}" driver does not support copying. Read the object with disk.get() and write it with disk.put().`,
    )
  }
}

/** The driver cannot report object metadata without downloading the object. */
export class StatUnsupportedError extends BasaltError {
  constructor(driver: string, detail?: string) {
    super(
      'STORAGE_STAT_UNSUPPORTED',
      detail ??
        `The "${driver}" driver does not support stat(). Use disk.exists(), or a driver that implements stat (local, s3, azure, gcs).`,
    )
  }
}

/**
 * The per-call (or per-driver) signing endpoint is not a usable base URL.
 * 400: the caller chose it. Only ever point it at another host of the SAME
 * bucket — an internal service name, a CDN alias — never at a third party.
 */
export class StorageSigningEndpointInvalidError extends BasaltError {
  readonly status = 400
  constructor(reason: string) {
    super('STORAGE_SIGNING_ENDPOINT_INVALID', `Invalid signing endpoint: ${reason}`)
  }
}

/**
 * A streaming upload needs an exact `contentLength` on this backend and none
 * was given. 400: the caller chose the body.
 */
export class StorageStreamLengthRequiredError extends BasaltError {
  readonly status = 400
  constructor(driver: string, detail: string) {
    super('STORAGE_STREAM_LENGTH_REQUIRED', `The "${driver}" driver needs a known body length: ${detail}`)
  }
}

/**
 * The `contentLength` given to `putStream` is not a byte count: negative,
 * fractional, not finite, or past `Number.MAX_SAFE_INTEGER`. Refused before a
 * single byte is read. 400: the caller declared it.
 */
export class StorageContentLengthInvalidError extends BasaltError {
  readonly status = 400
  constructor(value: unknown) {
    super('STORAGE_CONTENT_LENGTH_INVALID', `contentLength must be a non-negative safe integer; received ${String(value)}.`)
  }
}

/**
 * A streaming upload's body did not carry the `contentLength` it declared.
 * Raised mid-stream — the moment the body passes the declared size, or at its
 * end when it falls short — and always BEFORE the end of the body reaches the
 * driver, so a backend that commits on end (S3, GCS, Azure) never stores an
 * object whose size contradicts the declaration. 400: the caller sent the body.
 */
export class StorageContentLengthMismatchError extends BasaltError {
  readonly status = 400
  constructor(
    readonly declared: number,
    readonly received: number,
    ended: boolean,
  ) {
    super(
      'STORAGE_CONTENT_LENGTH_MISMATCH',
      ended
        ? `Upload declared ${declared} bytes but its body ended after ${received}.`
        : `Upload declared ${declared} bytes but its body carried more (${received} so far).`,
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
 * A tenant-scoped disk ran without a tenant in context. Fails closed: the
 * alternative is resolving the caller's key against the bucket root, where
 * every tenant's `tenants/<id>/` tree lives. Raised by any disk with a scope
 * unless it opted into `onMissingScope: 'root'` — or it is a `storagePlugin`
 * disk on the default scope in an app without `@basaltkit/tenancy`. 400, the
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
 * a tenant id that is not one canonical path segment (`..`, `a/b`, control
 * characters, `Acme`, `ÄCME`). Refused so a tenant id can never address
 * another tenant's tree or the bucket root — including on a case- or
 * normalization-insensitive filesystem (APFS, NTFS), where `Acme` and `acme`
 * would otherwise open the same directory while S3 keeps them apart.
 */
export class StorageInvalidScopeError extends BasaltError {
  constructor() {
    super(
      'STORAGE_INVALID_SCOPE',
      'Invalid storage scope: the tenant id (or custom scope) is not a safe path prefix. ' +
        'Scope segments may not be empty, ".", "..", contain "/" or "\\", or include control characters; ' +
        'with the default scope the tenant id must also be canonical — lowercase ASCII letters, digits, ' +
        '"-", "_" and inner "." only. Map other ids to a canonical segment with a custom scope.',
    )
  }
}

/**
 * A copy running on a tenant-scoped disk named a central (`scope: null`)
 * destination inside the `tenants/` tree. The destination disk has no scope to
 * contain the key, so it would land in whichever tenant's tree the key names.
 * 403: the caller asked to write where its tenant may not.
 */
export class StorageCrossTenantCopyError extends BasaltError {
  readonly status = 403
  constructor(disk: string, key: string) {
    super(
      'STORAGE_CROSS_TENANT_COPY',
      `Refusing to copy into "${key}" on central disk "${disk}" from a tenant-scoped disk: ` +
        'the tenants/ tree belongs to the tenants. Copy to a tenant-scoped disk, or outside tenants/.',
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
