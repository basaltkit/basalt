# Authentication

`@machize/auth` provides complete server-side authentication with the data in
**your** database — no vendor lock-in. Password hashing, JWT with refresh
rotation, sessions and ready-made routes.

## Setup

```ts
import { authPlugin, MemoryUserSource } from '@machize/auth'

authPlugin({
  users: new MemoryUserSource(), // implement UserSource over your database
  secret: process.env.APP_SECRET,
  accessTtl: '15m',
  refreshTtl: '30d',
})
```

## Ready-made routes

Register the built-in routes — each is a plain route you can replace or omit:

```ts
import { authRoutes } from '@machize/auth'
import { fastifyPlugin } from '@machize/fastify'

fastifyPlugin({ routes: [...appRoutes, ...authRoutes()] })
```

This exposes `POST /auth/register`, `/auth/login`, `/auth/refresh`,
`/auth/logout` and `GET /auth/me`, plus **email verification** and **password
reset** (`/auth/verify/request`, `/auth/verify`, `/auth/password/forgot`,
`/auth/password/reset`). The request/forgot routes always answer `200` so the
response never reveals whether an account exists; the token is emailed via the
`auth:verify_requested` / `auth:password_reset_requested` hooks, never returned
over HTTP. A completed password reset revokes every refresh token.

## Refresh rotation with reuse detection

Every refresh consumes the token and issues a new one in the same family. If a
consumed token comes back — a theft indicator — the whole family is revoked:

```ts
const { tokens } = await auth.login(email, password)
const next = await auth.refresh(tokens.refreshToken) // old token now dead

// replaying the old token throws AUTH_REFRESH_REUSED and kills the family
await auth.refresh(tokens.refreshToken)
```

Passwords are hashed with **scrypt** (memory-hard, zero dependencies); an
argon2id driver can be swapped in via the `PasswordHasher` contract.

## Guarding routes

Declare `meta.auth` on a route; the guard requires an authenticated user and
returns `401 AUTH_REQUIRED` otherwise:

```ts
route({
  method: 'GET',
  url: '/me',
  meta: { auth: true },
  async handler() {
    return ctx().user
  },
})
```

## Multi-factor authentication (TOTP)

Register `mfaRoutes()` for enroll / activate / status / disable. Once a user
enables MFA, `login` requires a code — pass it as the optional third argument
(or the `mfaCode` field on `POST /auth/login`):

```ts
await auth.login(email, password)            // → throws MfaRequiredError (401 AUTH_MFA_REQUIRED)
await auth.login(email, password, '123456')  // → tokens
```

A correct password with a missing code is **not** a failed attempt; a wrong
code is, so the login throttle still guards the second factor. Enrollment
returns an `otpauth://` URI to render as a QR code and one-time recovery codes
(stored as SHA-256 hashes). The TOTP implementation is dependency-free and
verified against the RFC 6238 test vectors.

## API keys

`apiKeysPlugin()` authenticates `mk_live_…` keys (via `Authorization: Bearer`
or `x-api-key`) and enforces `meta.scopes` on routes. Keys are tenant-scoped,
created by a logged-in user through `apiKeyRoutes()`, and stored only as a
SHA-256 hash plus a short display prefix — the plaintext is shown exactly once.

## Events

Each step emits an event — `auth:login`, `auth:login_failed`,
`auth:registered`, `auth:logout`, `auth:email_verified`, `auth:password_reset`,
`auth:mfa_enabled`, `auth:apikey_issued` and more — consumed for free by
[audit](/reference/packages) and notifications.

For the full end-to-end wiring (email plumbing, teams, and billing), see the
[account lifecycle cookbook](/cookbook/account-lifecycle).
