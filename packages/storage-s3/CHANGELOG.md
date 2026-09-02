# @basaltkit/storage-s3

## 1.0.0

### Major Changes

- e19b765: **New package: the S3-compatible driver for `@basaltkit/storage`**, extracted
  from the core so consumers who do not use S3 stop installing the AWS SDK.
  
  ```bash
  pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
  ```
  
  ```ts
  import { s3Disk } from '@basaltkit/storage-s3'
  
  storagePlugin({ disks: { uploads: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }) } })
  ```
  
  Exports `s3Disk()`, `S3StorageDriver` and `S3DriverOptions`. Works with AWS S3,
  MinIO, Cloudflare R2 and anything else speaking the S3 API — set `endpoint` and
  `forcePathStyle` flips to `true` automatically.
  
  The driver code is unchanged from `@basaltkit/storage`; this is a move, and its
  tests moved with it. The AWS packages are peer dependencies, which is what keeps
  them out of the trees of apps on local, Azure or GCS.

### Patch Changes

- Updated dependencies [e19b765]
  - @basaltkit/storage@2.0.0
