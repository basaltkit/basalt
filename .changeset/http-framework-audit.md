---
"@basaltkit/http": patch
---

Security and correctness fixes from the framework audit.

- **Rate-limit buckets that used up their limit are never evicted (FA-014).** `MemoryRateLimitStore` evicted the oldest windows once `maxEntries` was reached — including a client that was currently limited, so a flood of fresh keys (cheap with IPv6) reset it early. Exhausted buckets are now held apart and kept until their window ends; only open windows are evicted, still in amortised O(1).
- **CORS preflights go through the rate limiter and disclose nothing to disallowed origins (FA-015).** `securityPlugin` answered `OPTIONS` preflights before the rate limiter, so they were never counted; they now count against the global bucket (past it, `429`). A preflight from an origin the `cors` config does not allow still gets `204`, but without `Access-Control-Allow-Methods`, `-Allow-Headers` (which echoed the requested headers) or `-Max-Age`.
- **A toolkit 500 no longer serialises its internal message (FA-041).** `toErrorResponse` sent the message of any `BasaltError` with a numeric `status` — for internal 500s such as `GuardsWithoutContainerError` or `UserUpdateUnsupportedError` that text names options and internals. A `BasaltError` with `status` 500 now answers its `code` with `Internal server error.` and no `details`; the adapters still report the real error to the log. `HttpError`, errors that set `expose = true`, and other 5xx statuses (a 503 "retry shortly", a 501 "not supported") are client-facing by design and unchanged.
- **`expose = false` hides an error's message at any status.** A `BasaltError` that sets `expose = false` answers only its `code` and a neutral message (`Bad gateway.` for a 502, `Service unavailable.` for a 503, …) without `details`, and keeps the real text for the log. Used by `OAuthExchangeError` and `DriveHostNotAllowedError`, whose 502 messages quoted an upstream reply or an internal host.
