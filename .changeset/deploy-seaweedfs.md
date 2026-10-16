---
'@basaltkit/deploy': minor
---

SeaweedFS in place of MinIO (RFC 0010). MinIO's community edition is archived, and `minio` is removed: `dockerInfra(app, { minio })` and `external({ minio })` are refused with the way out.

- `dockerInfra(app, { seaweedfs: { buckets } })`: one `chrislusf/seaweedfs:4.48` container. Only the S3 API is published (127.0.0.1); master, volume and filer listen on the container's loopback; Iceberg and Lance are off; the admin gRPC requires a generated signing key (4.48 otherwise accepts identities from any neighbour on the network). Healthy once a volume server has joined, not only `/healthz`. Its credentials are not in the data, so new ones on an old volume are a rotation.
- `external({ s3: { keys, hostEndpoint, buckets } })`: any S3-compatible store, checked with the `.env`'s credentials before the build.
- Buckets, versioning and the expiry rule over the S3 API (SigV4, signed in the deploy) instead of `mc`: the rule is added next to existing ones, then read back.
- Moving off MinIO: the README.
