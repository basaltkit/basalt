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

export class ImageProcessingUnavailableError extends BasaltError {
  constructor(
    detail = 'No image processor configured. Install @basaltkit/image-sharp and pass it to storagePlugin({ imageProcessor }).',
  ) {
    super('STORAGE_IMAGE_UNAVAILABLE', detail)
  }
}
