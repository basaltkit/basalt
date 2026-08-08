# @machize/realtime-client

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

### Minor Changes

- 9b08e07: New package: `@machize/realtime-client` — the browser client for `@machize/realtime`.

  A zero-dependency client that subscribes to per-tenant channels and receives events over WebSocket (bidirectional, sends subscribe/unsubscribe) or SSE (receive-only), routing them by channel + event to handlers. Registering a handler auto-subscribes the channel, and the client re-subscribes every active channel when the connection (re)opens. Auto-reconnect uses exponential backoff (configurable, or `reconnect: false`), and `close()` stops it. The `WebSocket`/`EventSource` implementations are injectable, so the whole client — subscription, routing, reconnect, lifecycle events — is unit-tested with fakes, no browser or server required.
