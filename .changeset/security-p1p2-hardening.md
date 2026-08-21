---
"@basaltkit/auth": minor
"@basaltkit/auth-prisma": minor
"@basaltkit/auth-sqlite": minor
"@basaltkit/fastify": minor
"@basaltkit/mailer": minor
"@basaltkit/audit": minor
"@basaltkit/webhooks": minor
"@basaltkit/prisma": patch
---

Security P1/P2 hardening batch (from the deep audit):

- **auth (H-2):** TOTP codes are now single-use within their window — the accepted step is recorded (`MfaRecord.lastUsedStep`, persisted by auth-prisma/auth-sqlite) and a code at a step ≤ the last accepted is rejected. Prevents replay of an intercepted 6-digit code. New `matchTotpStep()` helper.
- **auth (M-1):** per-IP login throttle (`ipLoginThrottle`, on by default) in addition to the per-email one — blunts password spraying and lockout-DoS. `login()` takes an optional `{ ip }`; the login route passes the client IP.
- **fastify (HTTP M-1):** idempotency key reservation is now atomic — the Redis driver reserves with `SET … NX PX`, and the plugin reserves-then-falls-back-to-read, so two concurrent first-time requests can't both execute (no double-charge). `IdempotencyStore.setPending` now returns whether it won the reservation.
- **mailer (PII F4):** a single validation choke point (`assertHeaderSafe` in `resolve()`) rejects CR/LF in the subject and malformed/CRLF-bearing addresses (`to`/`cc`/`bcc`/`replyTo`/`from`) — closes email header injection. Display-name addresses still allowed.
- **audit (PII F2):** `trail()` now FORCES the context tenant, so a caller-supplied `tenantId` can't widen the read to another tenant; with no tenant in context it throws instead of returning all tenants. New `systemTrail()` is the explicit system-only cross-tenant escape hatch. Adds opt-in `piiMinimizingRedactor`.
- **webhooks (injection M-1):** DNS-rebinding is closed by pinning the outbound connection to the SSRF-validated IP (custom `lookup` over the built-in http/https transport); the `Host` header/TLS SNI stay correct. New `resolveAndValidate`/`pinnedLookup`/`PINNED_ADDRESS`.
- **prisma:** cap the `@prisma/client` peer range at `>=5.0.0 <8` (was unbounded).

Also: the CI supply-chain audit gate is green again — the two dev/build-only HIGH advisories (nanoid, deepmerge-ts) are scoped-ignored with justification in `pnpm-workspace.yaml`.

Note: `MfaRecord` gained an optional `lastUsedStep` column — auth-prisma users run `prisma db push`; auth-sqlite migrates automatically (idempotent `ALTER TABLE`).
