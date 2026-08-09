# @basaltkit/auth

Complete authentication for Basalt applications: user registration and login, JWT tokens with secure renewal, sessions, email verification, password recovery, two-factor authentication (MFA/TOTP), and API keys — all with ready-to-use HTTP routes.

You need this module whenever your application has users who log in.

## What this module solves

When an application has user accounts, it needs to answer two questions on every request: "who are you?" (authentication) and "how do you prove it?". Doing this by hand is difficult and dangerous — storing passwords securely, generating and validating **tokens** (small digital "tickets" that prove identity without sending the password on every request), preventing brute-force attacks, and so on.

`@basaltkit/auth` handles all of this for you. Passwords are never stored in plain text — only an irreversibly scrambled version (**hash**, using the scrypt algorithm). Login returns a pair of tokens: an **access token** (short-lived JWT, 15 minutes by default, sent with every request) and a **refresh token** (long-lived, 30 days, used only to obtain a new access token). If a refresh token is used twice — a typical sign of theft — the entire token "family" is automatically revoked.

It also includes, with nothing extra to install: account lockout after too many failed attempts, email verification and password recovery via single-use links, MFA via authenticator app (Google Authenticator, etc.) with recovery codes, and API keys for programmatic access (scripts, integrations).

## Installation

```bash
pnpm add @basaltkit/auth
```

Requirements: `@basaltkit/core` and `@basaltkit/fastify` (installed automatically as dependencies) and `zod` (peer dependency — install with `pnpm add zod`).

## Get started in 5 minutes

Step by step to get registration and login working:

1. **Create the application** with the auth plugin and the ready-made routes:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const app = await createApp({
  plugins: [
    authPlugin({
      users: new MemoryUserSource(), // in production: your database
      secret: process.env.AUTH_SECRET!, // secret that signs the tokens
    }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

2. **Register a user** (the `POST /auth/register` route already exists):

```bash
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
```

3. **Log in** and receive the tokens:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
# → { "user": {...}, "accessToken": "...", "refreshToken": "..." }
```

4. **Use the access token** to reach protected routes:

```bash
curl http://localhost:3000/auth/me \
  -H 'authorization: Bearer YOUR_ACCESS_TOKEN_HERE'
```

5. **Protect your own routes** with `meta: { auth: true }`:

```ts
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/fastify'

const myRoute = route({
  method: 'GET',
  url: '/dashboard',
  meta: { auth: true }, // not logged in → 401 AUTH_REQUIRED
  async handler() {
    return { hello: ctx().user?.email }
  },
})
```

> **Note:** `MemoryUserSource` stores users in memory — great for experimenting, but everything disappears when the process restarts. In production, implement the `UserSource` interface over your database (see below).

## Usage guide

### Connecting to your database (UserSource)

The module doesn't impose any database. You provide an object that fulfills the `UserSource` interface:

```ts
import type { UserSource, AuthUser, UserPatch } from '@basaltkit/auth'

const users: UserSource = {
  async findByEmail(email) { /* SELECT ... WHERE email = ? */ return null },
  async findById(id) { /* SELECT ... WHERE id = ? */ return null },
  async create(data) {
    // data = { email, passwordHash } — the hash is already computed
    return { id: 'new-id', ...data } as AuthUser
  },
  // Optional, but required for email verification and password reset:
  async update(id, patch: UserPatch) { /* UPDATE ... */ return null },
}
```

### Register, login, and logout (by code)

All operations are also available programmatically through the `Auth` class:

```ts
import { Auth, MemoryUserSource } from '@basaltkit/auth'

const auth = new Auth({ users: new MemoryUserSource(), secret: 'a-strong-secret' })

const user = await auth.register('ada@example.com', 'secretpassword1')
const { tokens } = await auth.login('ada@example.com', 'secretpassword1')
const renewed = await auth.refresh(tokens.refreshToken) // new token pair
await auth.revoke(renewed.refreshToken) // logout: invalidates the token family
```

### Protecting routes

`authPlugin` automatically registers:

- An **enricher** that reads the `Authorization: Bearer <jwt>` or `x-session-id` header and places the user in `ctx().user` (of type `PublicUser` — never includes the password hash).
- A **guard** that rejects with 401 any route with `meta: { auth: true }` without an authenticated user.

A request with no credentials stays anonymous (no error); an explicit invalid token returns 401.

### Password recovery

The flow has two steps. The module generates a **single-use token** (valid for 1 hour by default) and emits a hook — your application sends the email with the link:

```ts
// 1. Listen to the hook and send the email (do this once, at startup)
app.hooks.on('auth:password_reset_requested', async ({ user, token }) => {
  await sendEmail(user.email, `https://app.example.com/reset?token=${token}`)
})
```

Ready-made routes: `POST /auth/password/forgot` (body `{ email }` — always responds 200, so as not to reveal whether the email exists) and `POST /auth/password/reset` (body `{ token, password }`). After the reset, **all of the user's sessions and refresh tokens are revoked**.

Email verification works the same way: hook `auth:verify_requested`, routes `POST /auth/verify/request` and `POST /auth/verify` (token valid for 24 hours by default).

### MFA — two-factor authentication (TOTP)

**TOTP** is the 6-digit code generated by apps like Google Authenticator. Register the routes:

```ts
import { authRoutes, mfaRoutes } from '@basaltkit/auth'
import { fastifyPlugin } from '@basaltkit/fastify'

fastifyPlugin({ routes: [...authRoutes(), ...mfaRoutes()] })
```

Flow (all routes require login):

1. `POST /auth/mfa/enroll` → returns `{ secret, otpauthUri }`; show the `otpauthUri` as a QR code.
2. `POST /auth/mfa/activate` with `{ code }` (code from the app) → activates and returns `{ recoveryCodes }` — 10 single-use recovery codes, **shown only once**.
3. From then on, `POST /auth/login` requires the extra `mfaCode` field (TOTP code or a recovery code). Correct password without a code → `AUTH_MFA_REQUIRED` error.
4. `GET /auth/mfa/status` and `POST /auth/mfa/disable` (with `{ code }`) complete the cycle.

### API keys

For programmatic access (scripts, CI, integrations) without interactive login. A key has the format `mk_live_...`, is shown **only once** when created, and only its SHA-256 hash is stored.

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import {
  authPlugin, authRoutes, apiKeysPlugin, apiKeyRoutes, MemoryUserSource,
} from '@basaltkit/auth'

const users = new MemoryUserSource()
const app = await createApp({
  plugins: [
    authPlugin({ users, secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin({ users }), // authenticates keys and enforces scopes
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), // POST/GET /apikeys, DELETE /apikeys/:id
        route({
          method: 'GET',
          url: '/reports',
          meta: { scopes: ['reports:read'] }, // requires a key with this scope
          async handler() { return { ok: true } },
        }),
      ],
    }),
  ],
}).boot()
```

The key is presented in the `Authorization: Bearer mk_live_...` or `x-api-key` header. A **scope** is a granular permission on the key (e.g. `reports:read`); `*` means all. After authenticating, `ctx().apiKey` contains `{ id, scopes, tenantId?, userId? }`.

### Brute-force lockout (LoginThrottle)

Active by default: 5 failed attempts per email within a 15-minute window → `AUTH_LOCKED` error (HTTP 429). A successful login clears the counter.

```ts
import { authPlugin, LoginThrottle, MemoryUserSource } from '@basaltkit/auth'

authPlugin({
  users: new MemoryUserSource(),
  secret: process.env.AUTH_SECRET!,
  loginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 10 * 60_000 }),
  // or loginThrottle: false to disable (not recommended)
})
```

### Hooks (events)

The application can react to authentication events: `auth:registered`, `auth:login`, `auth:login_failed`, `auth:logout`, `auth:verify_requested`, `auth:email_verified`, `auth:password_reset_requested`, `auth:password_reset`, `auth:mfa_enabled`, `auth:mfa_disabled`, `auth:apikey_issued`, `auth:apikey_revoked`.

## API reference

### `authPlugin(options)` and the `Auth` class

Options (`AuthOptions` / `AuthPluginOptions` — the plugin accepts the same minus `hooks`):

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `users` | `UserSource` | Yes | — | Where users come from (your DB). |
| `secret` | `string` | Yes | — | Secret that signs the JWTs (HS256). |
| `hasher` | `PasswordHasher` | No | `ScryptPasswordHasher` | Password hashing algorithm. |
| `sessions` | `SessionStore` | No | `MemorySessionStore` | Session storage. |
| `refreshTokens` | `RefreshTokenStore` | No | `MemoryRefreshTokenStore` | Refresh token storage. |
| `accessTtl` | `DurationInput` | No | `'15m'` | Access token validity. |
| `refreshTtl` | `DurationInput` | No | `'30d'` | Refresh token validity. |
| `sessionTtl` | `DurationInput` | No | `'30d'` | Session validity. |
| `loginThrottle` | `LoginThrottle \| false` | No | active (5/15min) | Anti brute-force lockout; `false` disables it. |
| `tokens` | `AuthTokenStore` | No | `MemoryAuthTokenStore` | Verification/reset tokens. |
| `verificationTtl` | `DurationInput` | No | `'24h'` | Email verification link validity. |
| `resetTtl` | `DurationInput` | No | `'1h'` | Password reset link validity. |
| `mfa` | `MfaStore` | No | `MemoryMfaStore` | Per-user MFA state. |
| `mfaIssuer` | `string` | No | `'Basalt'` | Name shown in the authenticator app. |
| `hooks` | `HookBus` | No | — | Only on the `Auth` class; the plugin injects it. |

`Auth` class methods:

| Method | Description |
|---|---|
| `register(email, password)` | Creates the account; throws `EmailTakenError` if the email already exists. |
| `login(email, password, mfaCode?)` | Returns `{ user, tokens }`; applies throttle and MFA. |
| `attempt(email, password)` | Checks credentials without side effects; `null` on failure. |
| `refresh(refreshToken)` | New token pair; detects reuse and revokes the family. |
| `revoke(refreshToken)` | Logout for token-based clients. |
| `verifyAccess(accessToken)` | Validates the JWT and returns the claims. |
| `createSession(userId)` / `sessionUser(sessionId)` / `logout(sessionId)` | Cookie/header-based sessions. |
| `requestEmailVerification(email)` / `verifyEmail(token)` | Email verification. |
| `requestPasswordReset(email)` / `resetPassword(token, newPassword)` | Password recovery. |
| `enrollMfa(userId)` / `activateMfa(userId, code)` / `disableMfa(userId, code)` | MFA lifecycle. |
| `isMfaEnabled(userId)` / `mfaStatus(userId)` / `verifyMfaCode(userId, code)` | MFA state and verification. |

### Ready-made routes

- `authRoutes()`: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. These are regular routes — you can omit or replace any of them.
- `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id` (all require login; scoped to the current tenant/user).
- `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable`.

### `apiKeysPlugin(options)` and the `ApiKeys` class

Options (`ApiKeysPluginOptions`):

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `ApiKeyStore` | No | `MemoryApiKeyStore` | Key storage. |
| `header` | `string` | No | `'x-api-key'` | Alternative header to Bearer. |
| `users` | `UserSource` | No | — | If given, a key with `userId` also populates `ctx().user`. |
| `now` | `() => number` | No | `Date.now` | Injectable clock (tests). |

`ApiKeys` methods: `issue(input)` (returns `{ record, key }` — the plain-text key only appears here), `verify(presented)`, `list(filter)`, `get(id)`, `revoke(id)`. Helper `scopesSatisfy(granted, required)`.

### Exported utilities

| Export | Description |
|---|---|
| `signJwt(claims, { secret, expiresIn? })` / `verifyJwt(token, secret)` | Dependency-free HS256 JWT. Advanced. |
| `ScryptPasswordHasher` / `PasswordHasher` | Password hashing (scrypt, memory-hard). Advanced. |
| `LoginThrottle` (`maxAttempts` def. 5, `windowMs` def. 15 min, `clock`) | Anti brute-force. |
| `generateTotpSecret`, `totp`, `verifyTotp`, `otpauthUri`, `base32Encode`, `base32Decode` | TOTP primitives (RFC 6238). Advanced. |
| `publicUser(user)` | Converts `AuthUser` → `PublicUser` (removes the hash). |
| `AUTH`, `API_KEYS` | Injection tokens: `container.get(AUTH)` returns the `Auth` instance. |
| In-memory stores | `MemoryUserSource`, `MemorySessionStore`, `MemoryRefreshTokenStore`, `MemoryAuthTokenStore`, `MemoryApiKeyStore`, `MemoryMfaStore` — dev/testing. |

### Exported errors

| Error | Code | HTTP |
|---|---|---|
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 |
| `RefreshInvalidError` / `RefreshReusedError` | `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REUSED` | 401 |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 |
| `AuthTokenInvalidError` (verification/reset links) | `AUTH_TOKEN_INVALID` | 400 |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 |
| `MfaRequiredError` / `MfaInvalidCodeError` / `MfaNotEnrolledError` | `AUTH_MFA_*` | 401/401/400 |
| `AccountLockedError` | `AUTH_LOCKED` | 429 |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 |

## Common issues and solutions (FAQ)

**"Users disappear when I restart the server."** You're using `MemoryUserSource` (and in-memory stores). Implement `UserSource` (and the other stores) over your database.

**"401 AUTH_TOKEN_EXPIRED shortly after login."** The access token lasts 15 minutes by design. The client should call `POST /auth/refresh` with the refresh token to get a new pair — don't increase `accessTtl` to long values.

**"401 AUTH_REFRESH_REUSED."** The same refresh token was used twice. Each refresh returns a new token that replaces the previous one; always keep the most recent one. If this happens without a client bug, it may indicate token theft — the user will need to log in again (intentional behavior).

**"AUTH_UPDATE_UNSUPPORTED on email verification / reset."** Your `UserSource` doesn't implement the optional `update()` method. It's required for these two flows.

**"The email with the link is never sent."** The module doesn't send emails — it emits the `auth:verify_requested` and `auth:password_reset_requested` hooks with the token; your application listens to them and sends the email.

**"429 AUTH_LOCKED in tests."** The throttle is active by default. In tests, pass `loginThrottle: false`.

**"My API key doesn't work with authPlugin."** Correct: bearers prefixed with `mk_` are ignored by `authPlugin` and handled by `apiKeysPlugin` — register both.

## How it connects to other modules

- **@basaltkit/core** — provides the app, the container, the request context (`ctx()`), and hooks; auth sets `ctx().user` and `ctx().apiKey`.
- **@basaltkit/fastify** — the HTTP adapter that runs the enrichers/guards and serves the ready-made routes.
- **@basaltkit/permissions** — answers "what can you do?"; its `meta.can` guard uses the `ctx().user` that auth sets.
- **@basaltkit/tenancy** — defines `ctx().tenant`; API keys created within a tenant are scoped to that tenant.
- **@basaltkit/teams** — the `meta.teamRole` guard combines `ctx().user` (auth) with `ctx().tenant` (tenancy).

## Security best practices

- **The `secret` is the vault's key.** Use a long, random value (e.g. `openssl rand -base64 48`), store it in an environment variable, and never put it in code or in git. If it leaks, anyone can forge tokens.
- **Always use HTTPS.** Plain-text tokens on an unencrypted connection can be intercepted.
- **Don't increase `accessTtl`.** Short access tokens limit the damage from a stolen token; renewal via refresh token already provides convenience for the user.
- **Show the API key and recovery codes only once** — that's how the module works; don't store them in plain text on your side.
- **Don't disable `loginThrottle` in production**, and keep the "always 200" responses on the forgot/verify routes (already the default), so as not to reveal which emails have an account.
- **In a cluster (multiple machines)**, use shared stores (database/Redis) instead of the `Memory*` ones, or sessions and lockouts won't be shared across processes.
