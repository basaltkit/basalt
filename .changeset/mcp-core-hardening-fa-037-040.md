---
"@basaltkit/mcp-core": minor
---

Harden the MCP core and its transports (framework audit FA-037, FA-039, FA-040).
Minor because the package is 0.x, where a minor is the breaking slot — three
defaults change (marked **breaking**).

- **Breaking:** a request method sent as a notification (no `id`, e.g. a
  `tools/call` without one) is no longer executed nor answered — JSON-RPC never
  answers a notification. JSON-RPC responses sent to the server are ignored.
- In-flight calls are keyed by `(session, id)` (new `CallContext.session`):
  `notifications/cancelled` only aborts calls of the same session, so one client
  can no longer cancel another's request. Each stdio stream and each HTTP
  request is its own session; session-less embeddings keep one shared scope. A
  second in-flight request reusing an id in the same session is refused.
- **Breaking:** `serveHttp` refuses to bind a non-loopback `host` unless
  `authorize` (new — e.g. a bearer-token check answering `401`) or
  `allowRequest` is set: the Host/Origin guard is a browser guard, not
  authentication. `allowRequest` also receives the raw request.
- **Breaking:** `serveHttp` caps request bodies at `maxBodyBytes` (default
  1 MiB) and answers `413` without buffering the rest. It also aborts a call
  when its client disconnects and forwards the peer address as
  `ctx.remoteAddress`.
- stdio: implements `elicitation/create` — when the client announced the
  `elicitation` capability in `initialize`, tools receive `ctx.elicit`, which
  resolves `true` only for an `accept` with `confirm: true`. Client responses
  are routed back instead of being answered with an error.
- JSON-RPC batches are supported (as protocol revision 2025-03-26, which is
  advertised, requires) through the new `dispatchPayload`, used by every
  bundled transport.
- stdio decodes input with a `StringDecoder` (a multibyte character split
  across chunks no longer becomes U+FFFD) and drops lines longer than
  `maxLineLength` (default 4 MiB) with a `-32600` error instead of buffering
  them without bound.
