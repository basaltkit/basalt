---
"@basaltkit/webhooks": minor
---

Export a streaming SSRF-guarded HTTP client for untrusted URLs: `createGuardedFetch({ maxBytes, timeoutMs, deadlineMs?, allowedHosts?, allowedSchemes?, maxRedirects?, allowPrivateHosts?, lookup?, transport?, defaultHeaders?, mapError? })`. Unlike `pinnedFetch`, it hands the response body back as a capped `Readable` (plus `text()`, `json()`, `arrayBuffer()`, `destroy()`). Every redirect hop is re-validated and IP-pinned (max 3 by default, credentials dropped across hosts), no `accept-encoding` is sent, and the byte cap is enforced mid-stream. Refusals throw `GuardedFetchError` (`kind`: `SSRF_BLOCKED` · `BODY_TOO_LARGE` · `TIMEOUT` · `TOO_MANY_REDIRECTS`, code `OUTBOUND_<kind>`), naming the host and never the URL. Also exported: `hostAllowed`, `capStream`, `pinnedStreamTransport`.
