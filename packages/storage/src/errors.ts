import { MachizeError } from '@machize/core'

export class StorageFileNotFoundError extends MachizeError {
  constructor(path: string) {
    super('STORAGE_FILE_NOT_FOUND', `File not found: "${path}"`)
  }
}

export class StorageInvalidPathError extends MachizeError {
  constructor(path: string) {
    super(
      'STORAGE_INVALID_PATH',
      `Invalid storage path: "${path}". Paths must stay inside the disk root.`,
    )
  }
}

export class UnknownDiskError extends MachizeError {
  constructor(disk: string) {
    super(
      'STORAGE_UNKNOWN_DISK',
      `Unknown disk "${disk}". Declare it in storagePlugin({ disks: { ... } }).`,
    )
  }
}

export class TemporaryUrlUnsupportedError extends MachizeError {
  constructor(driver: string) {
    super(
      'STORAGE_TEMPORARY_URL_UNSUPPORTED',
      `The "${driver}" driver does not support temporary URLs. Use an S3-compatible disk.`,
    )
  }
}
