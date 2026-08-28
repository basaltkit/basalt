---
"@basaltkit/realtime": minor
---

The hook bridge is fire-and-forget: a failed broadcast can no longer fail the domain write.

Bridged rules used to return the broadcast promise into `hooks.emit`, so a backplane hiccup (e.g. Redis briefly down) rejected the very hook emission of the business operation that triggered it — a cosmetic realtime push failing a domain write. The bridge now dispatches without awaiting and reports failures through the new `onBridgeError(error, { hook, channel, event })` option (default: `console.error` with full context — failures stay observable, never silent).
