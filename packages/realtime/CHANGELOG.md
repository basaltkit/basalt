# @basaltkit/realtime

## 1.3.0

### Minor Changes

- 1050b3d: A dead socket can no longer blackhole a broadcast or crash the process.
  
  `deliverLocal` iterated subscribers calling `connection.send()` with no isolation: a throwing socket (aborted SSE response, CLOSING WebSocket) aborted the loop — every recipient after the dead one got nothing — and via the Redis backplane the exception escaped into ioredis's `message` emitter, an uncaught exception (fatal). Delivery is now isolated per recipient: a throwing `send` prunes that connection and reports it (new `onDeliveryError` option on the hub and `realtimePlugin`, default `console.error`), while everyone else still receives the message. The Redis backplane also guards `JSON.parse` and validates message shape, dropping malformed payloads instead of throwing into the subscriber emitter.

## 1.2.0

### Minor Changes

- 8a3e92a: The hook bridge is fire-and-forget: a failed broadcast can no longer fail the domain write.
  
  Bridged rules used to return the broadcast promise into `hooks.emit`, so a backplane hiccup (e.g. Redis briefly down) rejected the very hook emission of the business operation that triggered it — a cosmetic realtime push failing a domain write. The bridge now dispatches without awaiting and reports failures through the new `onBridgeError(error, { hook, channel, event })` option (default: `console.error` with full context — failures stay observable, never silent).

### Patch Changes

- Updated dependencies [8a3e92a]
  - @basaltkit/core@1.3.0

## 1.1.0

### Minor Changes

- Security hardening (channel authorization + DoS bounds):
  - **Subscription authorization seam (HIGH).** `RealtimeHub.subscribe` previously attached a connection to *any* client-supplied channel with no check, so any authenticated connection could subscribe to another user's private channel or an admin channel within its tenant and receive its broadcasts — and there was no hook to prevent it. `subscribe` is now `async` and returns whether the subscription was accepted; a new `authorize(connection, channel)` option (settable on `RealtimeHub` and `realtimePlugin`) gates every join. **Set it whenever channels carry data not readable by every member of the tenant.** Cross-tenant isolation was already enforced and is unchanged. Note: `subscribe` now returns `Promise<boolean>` — adapters should check the result and signal/close on refusal.
  - **DoS bounds.** `maxSubscriptionsPerConnection` (default 1000) and `maxChannelLength` (default 256) cap how many channels a single connection can hold and how long a channel name may be, so one socket can't exhaust memory by looping `subscribe` over unbounded distinct channels.

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
