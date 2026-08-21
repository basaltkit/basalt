# Authentication

`@basaltkit/auth` provides complete server-side authentication with the data in
**your** database — no vendor lock-in. Password hashing, JWT with refresh
rotation, sessions, MFA (TOTP), API keys and ready-made routes.

[[toc]]

## Setup

The quickest start uses the in-memory stores — perfect for experimenting, but
everything disappears on restart. Register the plugin and the ready-made routes:

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const app = await createApp({
  plugins: [
    authPlugin({
      users: new MemoryUserSource(), // in production: implement UserSource over your DB
      secret: process.env.AUTH_SECRET!, // signs the JWTs (HS256) — keep it secret
      accessTtl: '15m', // short-lived access token (default)
      refreshTtl: '30d', // long-lived refresh token (default)
    }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

::: warning The `secret` is the vault's key
Use a long, random value (`openssl rand -base64 48`), load it from an environment
variable, and never commit it. If it leaks, anyone can forge tokens. Always serve
auth over HTTPS.
:::

## Durable stores (production)

`authPlugin` accepts a store for each moving part — swap the `Memory*` defaults
for a durable backend and users stay logged in, API keys keep working, and
password-reset tokens survive a redeploy. Two official backends ship ready to go.

### SQLite — `@basaltkit/auth-sqlite`

Zero external dependencies, built on Node's `node:sqlite` (Node 22.5+; on 22.x
run with `--experimental-sqlite`, stable and flag-free on Node 24):

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db') // ':memory:' by default; opens + migrates

const app = await createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens, // email verification + password reset
      mfa: s.mfa,
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
    fastifyPlugin({ routes: authRoutes() }),
  ],
}).boot()
```

`sqliteAuthStores()` also accepts a `DatabaseSync` you already opened, so auth can
share one connection with the rest of your app. Individual stores
(`SqliteUserSource`, `SqliteSessionStore`, …) are exported too if you want to mix
backends.

### Prisma — `@basaltkit/auth-prisma`

For PostgreSQL/MySQL. Copy the `Auth*` models from
`@basaltkit/auth-prisma/schema.prisma` into your `schema.prisma`, run
`prisma migrate dev && prisma generate`, then:

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma) // pass the client directly, no cast

authPlugin({
  secret: process.env.AUTH_SECRET!,
  users: s.users,
  sessions: s.sessions,
  refreshTokens: s.refreshTokens,
  tokens: s.tokens,
  mfa: s.mfa,
})
apiKeysPlugin({ store: s.apiKeys, users: s.users })
```

::: tip Bring your own UserSource
No database? Implement the `UserSource` contract yourself — four methods over
your tables. `update` is optional but **required** for email verification and
password reset (`AUTH_UPDATE_UNSUPPORTED` if missing):

```ts
import type { UserSource, AuthUser, UserPatch } from '@basaltkit/auth'

const users: UserSource = {
  async findByEmail(email) { /* SELECT … WHERE email = ? */ return null },
  async findById(id) { /* SELECT … WHERE id = ? */ return null },
  async create(data) { // data = { email, passwordHash } — hash already computed
    return { id: crypto.randomUUID(), ...data } as AuthUser
  },
  async update(id, patch: UserPatch) { /* UPDATE … */ return null },
}
```
:::

## Ready-made routes

Register the built-in routes — each is a plain route you can replace or omit:

```ts
import { authRoutes, mfaRoutes, apiKeyRoutes } from '@basaltkit/auth'
import { fastifyPlugin } from '@basaltkit/fastify'

fastifyPlugin({ routes: [...appRoutes, ...authRoutes(), ...mfaRoutes(), ...apiKeyRoutes()] })
```

`authRoutes()` exposes:

| Endpoint | Body | Notes |
| --- | --- | --- |
| `POST /auth/register` | `{ email, password }` | → `EmailTakenError` (409) if taken |
| `POST /auth/login` | `{ email, password, mfaCode? }` | → `{ user, accessToken, refreshToken }` |
| `POST /auth/refresh` | `{ refreshToken }` | new token pair; kills the family on reuse |
| `POST /auth/logout` | `{ refreshToken }` | revokes the refresh family |
| `GET /auth/me` | — | requires `Authorization: Bearer <jwt>` |
| `POST /auth/verify/request` · `POST /auth/verify` | `{ email }` · `{ token }` | email verification |
| `POST /auth/password/forgot` · `POST /auth/password/reset` | `{ email }` · `{ token, password }` | password reset |

The `verify/request` and `password/forgot` routes always answer `200` so the
response never reveals whether an account exists; the token is emailed via the
`auth:verify_requested` / `auth:password_reset_requested` hooks, never returned
over HTTP. A completed password reset revokes every session and refresh token.

### The register → login → refresh flow (HTTP)

```bash
# 1. Register
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

# 2. Login → { user, accessToken, refreshToken }
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

# 3. Call a protected route with the access token
curl http://localhost:3000/auth/me -H 'authorization: Bearer <accessToken>'

# 4. When the access token expires (15m), swap the refresh token for a new pair
curl -X POST http://localhost:3000/auth/refresh \
  -H 'content-type: application/json' -d '{"refreshToken":"<refreshToken>"}'
```

### Same flow in code (the `Auth` class)

Every route is a thin wrapper over the `Auth` service — reach it from the
container with the `AUTH` token, or construct one directly:

```ts
import { AUTH } from '@basaltkit/auth'
const auth = app.container.get(AUTH)

const user = await auth.register('ada@example.com', 'secretpassword1')
const { user: u, tokens } = await auth.login('ada@example.com', 'secretpassword1')
// tokens = { accessToken, refreshToken }
const next = await auth.refresh(tokens.refreshToken) // → new { accessToken, refreshToken }
await auth.revoke(next.refreshToken) // logout for token-based clients
```

## Refresh rotation with reuse detection

Every refresh consumes the token and issues a new one in the same family. If a
consumed token comes back — a theft indicator — the whole family is revoked:

```ts
const { tokens } = await auth.login(email, password)
const next = await auth.refresh(tokens.refreshToken) // old token now dead

// replaying the old token throws RefreshReusedError (401 AUTH_REFRESH_REUSED)
// and kills the entire family — the user must log in again
await auth.refresh(tokens.refreshToken)
```

Passwords are hashed with **scrypt** (memory-hard, zero dependencies); an
argon2id driver can be swapped in via the `PasswordHasher` contract
(`hasher: new MyArgon2Hasher()`).

## Guarding routes and reading the user

`authPlugin` registers an **enricher** (reads `Authorization: Bearer <jwt>` or
`x-session-id` and sets `ctx().user`) and a **guard**. Declare `meta.auth` on a
route; the guard returns `401 AUTH_REQUIRED` for anonymous requests. `ctx().user`
is a `PublicUser` — it never includes the password hash:

```ts
import { ctx } from '@basaltkit/core'
import { route } from '@basaltkit/fastify'

route({
  method: 'GET',
  url: '/me',
  meta: { auth: true }, // anonymous → 401 AUTH_REQUIRED
  async handler() {
    const user = ctx().user // { id, email, emailVerified, … }
    return { hello: user?.email }
  },
})
```

A request with no credentials stays anonymous (no error); an explicit invalid or
expired token returns `401 AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED`.

## Multi-factor authentication (TOTP)

Register `mfaRoutes()` for enroll / activate / status / disable (all require
login). **TOTP** is the 6-digit code from apps like Google Authenticator.

```ts
fastifyPlugin({ routes: [...authRoutes(), ...mfaRoutes()] })
```

The enroll → activate → recovery flow:

```ts
const auth = app.container.get(AUTH)

// 1. Enroll: generate a pending secret + a QR URI to render
const { secret, otpauthUri } = await auth.enrollMfa(user.id)
//    otpauthUri → render as a QR code; secret → manual entry fallback

// 2. Activate with a code from the authenticator app → recovery codes (shown ONCE)
const { recoveryCodes } = await auth.activateMfa(user.id, '123456')
//    recoveryCodes: 10 single-use codes stored as SHA-256 hashes

// 3. Status / disable
await auth.mfaStatus(user.id)          // { enabled, pending }
await auth.disableMfa(user.id, '123456') // requires a valid current or recovery code
```

Over HTTP the same flow is `POST /auth/mfa/enroll` → `POST /auth/mfa/activate`
`{ code }` → `GET /auth/mfa/status` / `POST /auth/mfa/disable` `{ code }`.

Once MFA is on, `login` requires a code — pass it as the optional third argument
(or the `mfaCode` field on `POST /auth/login`):

```ts
await auth.login(email, password)            // → MfaRequiredError (401 AUTH_MFA_REQUIRED)
await auth.login(email, password, '123456')  // → { user, tokens }
```

A correct password with a missing code is **not** a failed attempt; a wrong code
throws `MfaInvalidCodeError` and counts toward the throttle. Both a TOTP code and
a recovery code are accepted (recovery codes are consumed on use). The TOTP
implementation is dependency-free and verified against the RFC 6238 test vectors.

## Social login (OAuth)

Sign in with Google or GitHub via the OAuth 2.0 authorization-code flow — no SDK,
and cookieless: the CSRF `state` is HMAC-signed and stateless.

```ts
import {
  authPlugin, oauthPlugin, oauthRoutes, authRoutes, googleProvider, githubProvider,
} from '@basaltkit/auth'

createApp({
  plugins: [
    authPlugin({ users, secret: env.APP_SECRET }),
    oauthPlugin({
      secret: env.APP_SECRET, // signs the state
      providers: [
        googleProvider({ clientId: env.GOOGLE_ID, clientSecret: env.GOOGLE_SECRET }),
        githubProvider({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET }),
      ],
    }),
  ],
})

// register the routes
fastifyPlugin({ routes: [...authRoutes(), ...oauthRoutes({ callbackBaseUrl: 'https://app.example.com' })] })
```

Two routes per provider are added:

- `GET /auth/oauth/:provider` → redirects to the provider. Register
  `${callbackBaseUrl}/auth/oauth/:provider/callback` as the provider's redirect URI.
- `GET /auth/oauth/:provider/callback` → verifies the state, exchanges the code,
  and logs the user in. The response is JSON `{ user, accessToken, refreshToken }`;
  pass `successRedirect` to bounce the browser back to your SPA with the tokens in
  the URL fragment instead.

New accounts are created **passwordless** (they authenticate via the provider
until a password is set); a provider-verified email flips `emailVerified`.
`Auth.socialLogin(email)` is the underlying primitive if you wire a custom provider.

::: warning Accounts are matched by email
Only trust providers that return a **verified** email. Google and the built-in
GitHub provider both do — GitHub's driver reads the primary *verified* address.
:::

### Enterprise SSO (OIDC)

Any OpenID Connect IdP — Okta, Azure AD / Entra ID, Auth0, Google Workspace,
Keycloak — plugs in as a provider. Give the three endpoints, or let
`discoverOidcProvider` read them from the IdP's `.well-known/openid-configuration`:

```ts
import { oidcProvider, discoverOidcProvider, oauthPlugin } from '@basaltkit/auth'

// explicit endpoints…
oidcProvider({ name: 'okta', authorizeUrl, tokenUrl, userInfoUrl, clientId, clientSecret })

// …or discovery (await at startup)
const okta = await discoverOidcProvider({ name: 'okta', issuer: 'https://acme.okta.com', clientId, clientSecret })
oauthPlugin({ secret: env.APP_SECRET, providers: [okta] })
```

(Legacy **SAML 2.0** IdPs are a separate integration — see the roadmap.)

## Password reset (end-to-end)

The module never sends email — it emits a hook carrying a single-use token
(valid 1 hour by default) for **your** app to email. Wire the hook once at
startup, then expose the two routes:

```ts
// 1. At startup: turn the hook into an email
app.hooks.on('auth:password_reset_requested', async ({ user, token }) => {
  await mailer.send(user.email, `https://app.example.com/reset?token=${token}`)
})
```

```bash
# 2. User asks to reset — always answers 200 (no account enumeration)
curl -X POST http://localhost:3000/auth/password/forgot \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'

# 3. User follows the emailed link and submits the new password
curl -X POST http://localhost:3000/auth/password/reset \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>","password":"a-new-strong-password"}'
```

In code the same steps are `auth.requestPasswordReset(email)` (returns
`{ user, token }` or `null` when no account matches) and
`auth.resetPassword(token, newPassword)`. Completing a reset **logs the user out
everywhere** — all sessions and refresh tokens are revoked. Email verification
works identically: hook `auth:verify_requested`, routes `POST /auth/verify/request`
and `POST /auth/verify` (token valid 24h).

## API keys

`apiKeysPlugin()` authenticates `mk_live_…` keys (via `Authorization: Bearer` or
`x-api-key`) and enforces `meta.scopes` on routes. Keys are tenant-scoped,
created by a logged-in user through `apiKeyRoutes()`, and stored only as a
SHA-256 hash plus a short display prefix — the plaintext is shown exactly once.

```ts
import { authPlugin, apiKeysPlugin, apiKeyRoutes, authRoutes, MemoryUserSource } from '@basaltkit/auth'

const users = new MemoryUserSource()
const app = await createApp({
  plugins: [
    authPlugin({ users, secret: process.env.AUTH_SECRET! }),
    apiKeysPlugin({ users }), // pass `users` so a key with userId also sets ctx().user
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        ...apiKeyRoutes(), // POST /apikeys, GET /apikeys, DELETE /apikeys/:id (all require login)
        route({
          method: 'GET',
          url: '/reports',
          meta: { scopes: ['reports:read'] }, // needs a key with this scope (or `*`)
          async handler() {
            const key = ctx().apiKey // { id, scopes, tenantId?, userId? }
            return { ok: true, keyId: key?.id }
          },
        }),
      ],
    }),
  ],
}).boot()
```

Issue a key in code with the `ApiKeys` service (the plaintext appears only here):

```ts
import { API_KEYS } from '@basaltkit/auth'
const apiKeys = app.container.get(API_KEYS)
const { record, key } = await apiKeys.issue({ name: 'CI pipeline', scopes: ['reports:read'] })
// key = 'mk_live_…' → show once, never store; record has prefix/scopes but no hash
```

::: warning Register both plugins
A bearer prefixed with `mk_` is ignored by `authPlugin` and handled by
`apiKeysPlugin`. If keys "don't work", you're likely missing `apiKeysPlugin()`.
:::

## Brute-force lockout

Active by default: 5 failed attempts per email within 15 minutes → `AccountLockedError`
(429 `AUTH_LOCKED`); a successful login clears the counter. Tune or disable it:

```ts
import { authPlugin, LoginThrottle } from '@basaltkit/auth'

authPlugin({
  users,
  secret: process.env.AUTH_SECRET!,
  loginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 10 * 60_000 }),
  // loginThrottle: false // disables it — not recommended (use in tests)
})
```

## Error codes

| Error | Code | HTTP |
| --- | --- | --- |
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 |
| `RefreshInvalidError` / `RefreshReusedError` | `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REUSED` | 401 |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 |
| `AuthTokenInvalidError` (verify/reset links) | `AUTH_TOKEN_INVALID` | 400 |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 |
| `MfaRequiredError` / `MfaInvalidCodeError` / `MfaNotEnrolledError` | `AUTH_MFA_*` | 401 / 401 / 400 |
| `AccountLockedError` | `AUTH_LOCKED` | 429 |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 |

## Events

Each step emits an event — `auth:login`, `auth:login_failed`, `auth:registered`,
`auth:logout`, `auth:verify_requested`, `auth:email_verified`,
`auth:password_reset_requested`, `auth:password_reset`, `auth:mfa_enabled`,
`auth:mfa_disabled`, `auth:apikey_issued`, `auth:apikey_revoked` — consumed for
free by [audit](/reference/packages) and notifications.

For the full end-to-end wiring (email plumbing, teams, and billing), see the
[account lifecycle cookbook](/cookbook/account-lifecycle).
