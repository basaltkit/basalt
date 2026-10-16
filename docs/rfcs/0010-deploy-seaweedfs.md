# RFC 0010 — `basalt-deploy`: SeaweedFS in place of MinIO

- **Status:** Accepted — implemented in `@basaltkit/deploy` 0.6
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-16
- **Affects:** `@basaltkit/deploy` only (`dockerInfra`, `external`, the bucket step, the generated compose file). No runtime package: `@basaltkit/storage-s3` already speaks to any S3-compatible store.
- **Builds on:** RFC 0006 (dedicated infra), RFC 0007 §4.2 (buckets kept on every deploy)
- **Non-negotiables honoured:** every port on 127.0.0.1; no secret on a command line, in a file the deploy writes or on the screen; the running container is the truth for its credentials; fail closed before anything is built

---

## 0. TL;DR

MinIO's community edition is archived: no images since October 2025, no fixes,
the repository read-only since 25 April 2026. The deploy created MinIO
containers and configured buckets with MinIO's own CLI (`mc`) inside them.

This RFC:

1. **Removes `minio`** from `dockerInfra()` and `external()`. A config that
   still names it is refused, with the way out (§1).
2. **Adds `seaweedfs`** to `dockerInfra()`: one `chrislusf/seaweedfs` container,
   S3 only published, everything else closed inside the container (§2, §3).
3. **Adds `s3`** to `external()`: any S3-compatible store the app reaches with
   the `.env`'s credentials (§4).
4. **Keeps the buckets over the S3 API**, signed (SigV4) in the deploy process —
   no vendor CLI, the same requests on SeaweedFS, Garage, R2 or AWS (§5).

## 1. Removing `minio`

A breaking change, in a 0.x minor (0.6.0). `dockerInfra(app, { minio })` throws
and `external({ minio })` fails validation, both with `MINIO_REMOVED`: what
replaced it and where the move is described (the package README, "Moving off
MinIO"). The deploy does not migrate data: copying objects is one `rclone sync`
the operator runs, and an automatic copy of production data is not something a
deploy should do on its own.

## 2. `dockerInfra(app, { seaweedfs })`

```ts
seaweedfs: {
  image: 'chrislusf/seaweedfs:4.48',        // pinned
  port: 'auto',                             // host port for S3 on 127.0.0.1; first free from 8333
  accessKey: app,
  buckets: [...],
  keys: { endpoint: 'S3_ENDPOINT', accessKey: 'S3_ACCESS_KEY', secretKey: 'S3_SECRET_KEY' },
  container: undefined,                     // default <app>-seaweedfs
}
```

One process (`weed server -s3`) runs master, volume, filer and S3. The S3
credentials come from the container's environment (`AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`), interpolated by compose from the deploy's environment
(`BASALT_S3_*`), as for Postgres and Redis.

**The credentials are not in the data.** Verified on 4.48: a container
recreated over the same volume with a new secret — and with a new access key —
reads every object, and the old pair is refused. So, unlike Postgres (incident
7), an old volume without its container is not an error: new credentials are a
rotation. The running container still wins over the `.env` when both exist.

**Health.** `/healthz` on the S3 port answers about two seconds before reads
work: the volume server has not joined the master yet, and a GET returns 500.
Healthy is `/healthz` **and** a data node in `/dir/status` — measured to turn
green with the first successful read.

## 3. What is reachable, and from where

The container is attached to the app's networks (`runtime.attach`) so the app
can reach S3 by name. Everything else SeaweedFS runs must not be reachable
there:

| Listener | Without care | Here |
|---|---|---|
| S3 API (8333) | all interfaces | all interfaces in the container; published on 127.0.0.1 only |
| master, volume, filer (9333, 8080, 8888 and gRPC) — **no authentication** | all interfaces | `-ip=127.0.0.1 -ip.bind=127.0.0.1`: the container's loopback |
| Iceberg REST catalog (8181), Lance (9101) | on by default | `-s3.port.iceberg=0 -s3.port.lance=0` |
| S3 admin gRPC (18333): put identity, policies | follows the S3 bind | open, but requires a signed token (below) |

**The admin gRPC.** On 4.48, with no signing key configured,
`SeaweedS3IamCache/PutIdentity` from a neighbouring container succeeded, and the
identity it created read the bucket. (Upstream restricted this to local callers
in #11530, after 4.48; no release carries it yet.) With
`WEED_JWT_FILER_SIGNING_KEY` set, the same call is refused
(`Unauthenticated`) and S3 is unaffected. The deploy generates that key
(32 random bytes), passes it like the other secrets, and reads it back from the
running container so a deploy does not restart the store for nothing.

Verified from a container on a shared network: 8333 and 18333 open, every other
port closed; `PutIdentity` refused.

## 4. `external({ s3 })`

```ts
s3: {
  keys: { endpoint, accessKey, secretKey },  // default S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY
  hostEndpoint: 'http://127.0.0.1:8333',     // when the .env names a container the host cannot resolve
  buckets: [...],
}
```

No container: the store may be anywhere. Before anything is built, the deploy
lists buckets with the `.env`'s credentials — a missing key, an unreachable
endpoint or refused credentials are preflight errors.

## 5. Buckets over the S3 API

`s3.ts`: a SigV4 signer (checked against the S3 documentation's example) and
`ensureBuckets`:

- `HEAD` each bucket; `PUT` when missing (`BucketAlreadyOwnedByYou` is fine).
- `versioned`: `GET ?versioning`, `PUT` only when not `Enabled`.
- `expireDays`: `GET ?lifecycle`; a rule counts only if enabled, with that
  expiry, over the whole bucket (no prefix, tag or `And`). Missing → the rule is
  **added to** the document (a lifecycle `PUT` replaces every rule; one set by
  hand stays), sent with `Content-MD5`, then read back — a store that accepts it
  and does not keep it is an error.

The secret never leaves the process: it signs, and is in no URL or header.

## 6. Not in this RFC

- Moving data between stores (§1).
- A multi-node SeaweedFS. One container is what the dedicated infra is for;
  larger setups are `external({ s3 })`.
- The monorepo's own development `docker-compose.yml` and the storage packages'
  documentation, which still show MinIO as an example of an S3-compatible
  store: their code does not depend on it.
