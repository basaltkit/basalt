# @machize/realtime

## 0.9.0

### Minor Changes

- 82c1d0e: New package: `@machize/realtime` — server-to-client push over WebSocket/SSE.

  A framework-neutral realtime layer: a `RealtimeHub` tracks connections, per-tenant channel subscriptions and presence; a pluggable `RealtimeBackplane` fans messages across instances (`MemoryBackplane` for one node, `RedisBackplane` for many). The `Realtime` service gives an ergonomic `to(tenant).channel(name).emit(event, data)` / `.presence()`, and `realtimePlugin({ bridge })` maps domain hooks straight to channels (`bridgeRule({ hook, tenant, channel, event, data })`). Transports are thin, adapter-agnostic helpers (`websocketConnection`, `sseConnection`, `sseFrame`) — the app builds a `Connection` from its socket/response and registers it. The core is fully unit-tested with fake connections and a fake Redis client, no server required.

### Patch Changes

- @machize/core@0.9.0
