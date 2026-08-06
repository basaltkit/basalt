# Security

Machize is **secure by default** at the HTTP edge and fail-closed on secrets.
Everything here is zero-dependency and wired through the plugin lifecycle.

## Edge protection — `securityPlugin`

One plugin covers rate limiting, CORS and secure response headers. All three
are on by default with sensible values.

```ts
import { securityPlugin } from '@machize/fastify'

securityPlugin({
  rateLimit: { limit: 100, windowMs: 60_000 },      // 100 req / minute / IP
  cors: { origin: ['https://app.example.com'], credentials: true },
  headers: true,                                     // secure defaults
})
```

### Rate limiting

A fixed-window limiter keyed by client IP (override with `key`). Blocked
requests get `429 RATE_LIMITED` with `Retry-After`, and every response carries
`X-RateLimit-Limit` / `-Remaining` / `-Reset`.

```ts
securityPlugin({
  rateLimit: {
    limit: 20,
    windowMs: 10_000,
    key: (req) => req.headers['x-api-key'] as string ?? req.ip,
    skip: (req) => req.url.startsWith('/livez'),
  },
})
```

The default store is in-memory (`MemoryRateLimitStore`). For multiple instances
implement the `RateLimitStore` interface over Redis — the same driver pattern
used by `@machize/cache`.

### CORS

`origin` accepts `true` (reflect), a string, an allow-list array, or a
predicate. Preflight `OPTIONS` requests are answered automatically.

### Secure headers

`headers: true` sets HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
`Cross-Origin-Opener-Policy: same-origin`. Pass an object to customize (e.g. a
`contentSecurityPolicy` for HTML surfaces) or `false` to disable.

## Fail-closed secrets — `secret()`

The most common production incident is shipping a placeholder signing key.
`secret()` makes that impossible:

```ts
import { defineEnv, secret } from '@machize/env'

export const env = defineEnv({
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

- **Development**: uses `devDefault` when unset — the app just runs.
- **Production** (`NODE_ENV=production`): the variable is **required**, must
  meet a minimum length, and is **rejected if it looks like a placeholder**
  (`change-me`, `secret`, `password`, …). The app refuses to boot otherwise.

## Brute-force lockout

`@machize/auth` throttles failed logins per email out of the box — no wiring
needed. After too many failures within a rolling window, `login()` throws
`AccountLockedError` (HTTP 429) even for the correct password; a success clears
the counter.

```ts
import { authPlugin, LoginThrottle } from '@machize/auth'

authPlugin({
  users,
  secret: env.APP_SECRET,
  // defaults to 5 attempts / 15 min; customize or disable:
  loginThrottle: new LoginThrottle({ maxAttempts: 10, windowMs: 5 * 60_000 }),
  // loginThrottle: false, // to turn it off
})
```

## Idempotent mutations — `idempotencyPlugin`

Safe retries for `POST`: a client that sends an `Idempotency-Key` gets the
**same** response replayed on a retry, so a dropped connection never charges a
card twice.

```ts
import { idempotencyPlugin } from '@machize/fastify'

idempotencyPlugin() // guards POST by default
```

- Repeat with the same key → the cached response, with `Idempotent-Replayed: true`.
- A repeat while the first is still in flight → `409 IDEMPOTENCY_CONFLICT`.
- `5xx` responses are **not** cached, so genuine failures stay retryable.
- Keys are scoped by method + route, so the same key on two endpoints can't collide.

## Supply chain

CI runs `pnpm audit` (high severity), **CodeQL** SAST, and **Dependabot** keeps
dependencies and Actions current. Releases publish to npm with **provenance**
(`NPM_CONFIG_PROVENANCE`) via changesets — no manual tokens or OTP in the
pipeline.
