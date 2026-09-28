---
'@basaltkit/auth': patch
'@basaltkit/drives': patch
---

502 errors no longer echo upstream detail to HTTP clients (framework audit, FA-041 follow-up).

- `OAuthExchangeError` (`AUTH_OAUTH_EXCHANGE_FAILED`) quoted the provider's reply — `error_description`, an HTTP status, the discovery URL. It now sets `expose = false`: the client gets the code and `Bad gateway.`, the log keeps the full message.
- `DriveHostNotAllowedError` (`DRIVE_HOST_NOT_ALLOWED`) named the host it refused to reach and why, which made every download route an oracle for internal host names. Same treatment; the message and `details` still reach the log, `drive:sync_failed` and the audit trail unchanged.

Requires `@basaltkit/http` with `expose = false` support (same release).
