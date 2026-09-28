# @basaltkit/realtime-client

## 1.0.3

### Patch Changes

- e53db52: Security fixes from the framework audit (FA-065, and the realtime part of FA-066).
  
  - **`subscribe()` re-checks after the async `authorize` gate (FA-065).** The connection and the per-connection cap were only checked *before* awaiting `authorize`. A socket that closed while the gate was deciding left a ghost subscription (and presence entry) behind; a different connection that reused the id during the gate — possibly from another tenant — inherited a channel authorized for someone else; and a burst of concurrent `subscribe` commands all passed the cap check before any attached, so `maxSubscriptionsPerConnection` could be overshot at will. After the gate resolves, `subscribe()` now resolves `false` unless the same connection object is still registered, and enforces the cap again. A non-string channel (an array or object from `JSON.parse` of a client frame) is refused instead of throwing or being keyed by identity.
  - **A non-serializable payload no longer disconnects every subscriber (FA-065).** A `BigInt` or a cycle in `data` threw inside each connection's `send`, so every subscriber was pruned as "dead" (and left with an open, silent socket). `hub.publish()` / `emit()` now rejects with the `TypeError` before anything is sent — as the Redis backplane already did — and a bridged emit reports it through `onBridgeError`.
  - **A pruned connection is now also closed.** When a `send` throws, the hub unregisters the connection *and* calls its `close()`, so the client notices the drop and reconnects instead of sitting on a socket that never receives again.
  - **No SSE frame injection through the event name (FA-065).** `sseFrame()` strips CR, LF and NUL from the event name; an event containing a newline could previously end the `event:` field and forge extra fields or whole frames.
  - **`RedisBackplane` can sign its messages (FA-066).** New `secret` option (a string, or an array to rotate — the first key signs, all verify): messages are published as an HMAC-SHA256-signed envelope, and anything unsigned, tampered or signed with another key is dropped and logged, so a client that can merely `PUBLISH` on the Redis can no longer push forged events into your tenants. An empty `secret` throws at construction. Without it the wire format is unchanged. Docs now warn that the default `'basalt:realtime'` channel is shared by every app/environment on the same Redis — give each deployment its own `channel`.
  - **Docs (realtime-client README, realtime README, guide):** the server-side WebSocket recipe now checks `Origin` against an allow-list (cross-site WebSocket hijacking — browsers send cookies with a cross-site WebSocket handshake) and parses client commands defensively (a throw from `JSON.parse` in an async socket listener is an unhandled rejection, fatal on Node by default).
  
  **Why minor, not major:** the only defaults that change are fixes of paths that never worked — an emit with non-JSON data used to "succeed" while disconnecting every recipient, and now rejects; a pruned socket is closed rather than left half-open. `secret` is opt-in. If you enable it, deploy it to all instances together: nodes with and without a key drop each other's pushes.

## 1.0.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

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

- 9b08e07: New package: `@basaltkit/realtime-client` — the browser client for `@basaltkit/realtime`.

  A zero-dependency client that subscribes to per-tenant channels and receives events over WebSocket (bidirectional, sends subscribe/unsubscribe) or SSE (receive-only), routing them by channel + event to handlers. Registering a handler auto-subscribes the channel, and the client re-subscribes every active channel when the connection (re)opens. Auto-reconnect uses exponential backoff (configurable, or `reconnect: false`), and `close()` stops it. The `WebSocket`/`EventSource` implementations are injectable, so the whole client — subscription, routing, reconnect, lifecycle events — is unit-tested with fakes, no browser or server required.
