# @basaltkit/realtime

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Minor Changes

- 82c1d0e: New package: `@basaltkit/realtime` — server-to-client push over WebSocket/SSE.

  A framework-neutral realtime layer: a `RealtimeHub` tracks connections, per-tenant channel subscriptions and presence; a pluggable `RealtimeBackplane` fans messages across instances (`MemoryBackplane` for one node, `RedisBackplane` for many). The `Realtime` service gives an ergonomic `to(tenant).channel(name).emit(event, data)` / `.presence()`, and `realtimePlugin({ bridge })` maps domain hooks straight to channels (`bridgeRule({ hook, tenant, channel, event, data })`). Transports are thin, adapter-agnostic helpers (`websocketConnection`, `sseConnection`, `sseFrame`) — the app builds a `Connection` from its socket/response and registers it. The core is fully unit-tested with fake connections and a fake Redis client, no server required.

### Patch Changes

- @basaltkit/core@0.9.0
