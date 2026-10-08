---
'@basaltkit/auth': minor
'@basaltkit/auth-sqlite': minor
'@basaltkit/auth-prisma': minor
---

BK-076: session hardening.

- `@basaltkit/auth`: `sessionIdleTtl` adds an idle timeout to server-side sessions — a session unused for longer is refused and deleted, on top of the absolute `sessionTtl`. Activity is recorded through the new optional `SessionStore.touch(id, at)`, throttled to once per `min(60s, sessionIdleTtl / 4)`; `SessionRecord` gains optional `lastSeenAt`. A store without `touch` makes `authPlugin` fail at boot (`SessionIdleConfigError`, `AUTH_SESSION_IDLE_CONFIG_INVALID`). A session cookie named `__Host-…` or `__Secure-…` now implies `Secure` (and `Path=/` for `__Host-`) when unset, and a contradicting `secure: false` or `__Host-` path fails at boot (`SessionCookieConfigError`, `AUTH_SESSION_COOKIE_INVALID`) instead of producing a cookie the browser silently drops. Without the new options nothing changes.
- `@basaltkit/auth-sqlite`: `SqliteSessionStore` records `last_seen_at` and implements `touch`; `migrate()` adds the column to existing databases.
- `@basaltkit/auth-prisma`: `trackSessionActivity: true` makes `PrismaSessionStore` write `AuthSession.lastSeenAt` and implement `touch`. Off by default, so an unmigrated database keeps working; the column is in the reference schemas — migrate before enabling.
