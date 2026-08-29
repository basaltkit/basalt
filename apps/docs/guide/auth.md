# Authentication

`@basaltkit/auth` provides complete server-side authentication with the data in
**your** database — no vendor lock-in. Password hashing, JWT with refresh
rotation, sessions, MFA (TOTP), passkeys, social login, API keys and ready-made
routes. It answers *who is calling*; it deliberately does not answer *what they
may do* — that is [authorization](/guide/authorization) — and it is decoupled
from the HTTP framework, so the same wiring works on Fastify, Express and Hono
(see [Adapters](/guide/adapters)).

[[toc]]

## Mental model

Five pieces, and you only ever wire the first two by hand:

| Piece | Registered by | What it does |
| --- | --- | --- |
| **Enricher** | `authPlugin` | Reads `Authorization: Bearer <jwt>` or `x-session-id` and sets `ctx().user`. **No** credentials → the request stays anonymous, no error. An *explicitly* invalid or expired token → `401` |
| **Guard** | `authPlugin` | A route declaring `meta: { auth: true }` requires `ctx().user` — anonymous → `401 AUTH_REQUIRED` |
| **Enricher + guard** | `apiKeysPlugin` | Authenticates `mk_`-prefixed bearers / `x-api-key` into `ctx().apiKey`, and enforces `meta.scopes` |
| **`Auth` service** | `authPlugin`, token `AUTH` | Everything the routes call: register, login, refresh, sessions, verification, reset, MFA. Reach it with `app.container.get(AUTH)` |
| **Routes** | `authRoutes()` · `mfaRoutes()` · `apiKeyRoutes()` · `oauthRoutes()` | Thin, replaceable wrappers over the service |

Two token lifetimes carry the session: a short **access token** (JWT, 15m) sent
on every request, and a long **refresh token** (30d) exchanged for a new pair.
Refresh is rotating with reuse detection — replaying a consumed token revokes the
whole family.

::: tip `meta.auth` is a request for protection, and it is checked at boot
`authPlugin` claims the `auth` meta key. A route that declares `meta.auth`
while `authPlugin` is **not** registered would serve unprotected, so every
adapter refuses to boot with `UnguardedRouteMetaError`
(`HTTP_UNGUARDED_ROUTE_META`) instead — detailed under *Guarding routes* below.
:::

## Setup

The quickest start uses the in-memory stores — perfect for experimenting, but
everything disappears on restart. Register the plugin and the ready-made routes:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
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

await app.container.get(FASTIFY).listen({ port: 3000 })
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
| `POST /auth/register` | `{ email, password }` | Always `202 { ok: true }` — enumeration-safe (see below) |
| `POST /auth/login` | `{ email, password, mfaCode? }` | → `{ user, accessToken, refreshToken }` |
| `POST /auth/refresh` | `{ refreshToken }` | new token pair; kills the family on reuse |
| `POST /auth/logout` | `{ refreshToken }` | `204`; revokes the refresh family |
| `GET /auth/me` | — | `meta.auth` — requires `Authorization: Bearer <jwt>` |
| `POST /auth/verify/request` · `POST /auth/verify` | `{ email }` · `{ token }` | email verification |
| `POST /auth/password/forgot` · `POST /auth/password/reset` | `{ email }` · `{ token, password }` | password reset |

`password` is validated at `min(8)` and `email` as an email address on every
route that takes them — a shorter password is a `400` validation error, not a
weak account.

::: tip Nothing here reveals whether an account exists
`POST /auth/register` answers the same `202 { ok: true }` for a fresh signup and
for an email that is already taken, and does *equivalent work* (it still hashes
the password) so the timing matches too. The collision is signalled out-of-band
through the `auth:register_existing_email` hook — email the address "you already
have an account, sign in or reset your password" instead of leaking existence in
the HTTP response. Set `enumerationSafeRegister: false` to get the older
`409 AUTH_EMAIL_TAKEN` behaviour; the lower-level `auth.register()` always throws
on a duplicate regardless.

`verify/request` and `password/forgot` answer `200` for the same reason; their
tokens are emailed via the `auth:verify_requested` /
`auth:password_reset_requested` hooks, never returned over HTTP. A completed
password reset revokes every session and refresh token.
:::

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

### `meta.auth` is verified at boot

Declaring `meta.auth` is a *request* for protection; the guard `authPlugin`
registers is what enforces it. A route that asks for protection nobody enforces
would serve unprotected and answer `200` — so every adapter calls the guarded-meta
check while registering routes and **refuses to boot**:

```
UnguardedRouteMetaError: Refusing to boot: 1 route(s) declare security meta that
NO registered guard enforces — they would serve unprotected:
  - GET /me declares meta.auth
```

The error carries `code: 'HTTP_UNGUARDED_ROUTE_META'` and names every offender.
The fix is normally to register the enforcing plugin: `auth` → `authPlugin`,
`can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`. When protection genuinely
happens at an outer edge (an API gateway that already authenticates), opt out
explicitly on the adapter:

```ts
fastifyPlugin({ routes, allowUnguardedMeta: ['auth'] }) // or `true` for every key
```

`meta: { auth: false }` is an explicit opt-*off*, not a protection request, and is
never flagged. The same option exists on `expressPlugin` and `honoPlugin` — see
[Adapters](/guide/adapters) — and the guard/meta split is laid out in
[Authorization](/guide/authorization).

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

## Passkeys (WebAuthn)

Passkeys let users sign in with Face ID, Touch ID or a hardware security key — no
password to phish or leak. Basalt drives the whole ceremony (challenges, browser
options, credential storage, single-use challenges, the clone-detection counter)
and delegates only the cryptography to a small verifier you implement over
[`@simplewebauthn/server`](https://simplewebauthn.dev), so the framework carries
no WebAuthn dependency.

```ts
import { webauthnPlugin, type WebAuthnVerifier } from '@basaltkit/auth'
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server'

const verifier: WebAuthnVerifier = {
  async verifyRegistration(i) {
    const v = await verifyRegistrationResponse({
      response: i.response as never,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.expectedOrigin,
      expectedRPID: i.expectedRpId,
      requireUserVerification: i.requireUserVerification,
    })
    if (!v.verified || !v.registrationInfo) return { verified: false }
    const c = v.registrationInfo.credential
    return { verified: true, credential: {
      id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter,
    } }
  },
  async verifyAuthentication(i) {
    const v = await verifyAuthenticationResponse({
      response: i.response as never,
      expectedChallenge: i.expectedChallenge,
      expectedOrigin: i.expectedOrigin,
      expectedRPID: i.expectedRpId,
      requireUserVerification: i.requireUserVerification,
      credential: {
        id: i.credential.id,
        publicKey: Buffer.from(i.credential.publicKey, 'base64url'),
        counter: i.credential.counter,
      },
    })
    return { verified: v.verified, newCounter: v.authenticationInfo?.newCounter ?? i.credential.counter }
  },
}

app.use(webauthnPlugin({
  config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
  verifier,
}))
```

### The four steps

Resolve the service from the `WEBAUTHN` token and drive it from your routes. The
`sessionKey` ties a challenge to the current session — the user id when signed in,
or a session id for logged-out login.

```ts
import { WEBAUTHN } from '@basaltkit/auth'
const passkeys = container.get(WEBAUTHN)

// 1. Register — a signed-in user adds a passkey
const regOptions = await passkeys.startRegistration(sessionKey, { id: user.id, name: user.email })
// → @simplewebauthn/browser startRegistration(regOptions), then POST the result back:
await passkeys.finishRegistration(sessionKey, user.id, browserResponse, 'MacBook')

// 2. Sign in — usernameless: omit the userId
await passkeys.startAuthentication(sessionKey)
const { userId } = await passkeys.finishAuthentication(sessionKey, browserResponse)
// → mint your session / JWT for userId
```

`finishAuthentication` looks the credential up by id, verifies it, checks the
signature counter **increased** (a clone throws `PasskeyClonedError`), and stores
the new counter. Use `passkeys.list(userId)` / `passkeys.remove(id)` for a
"manage devices" screen.

::: warning Security
The challenge is bound to the user you pass to `startRegistration`;
`finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` if the `userId` differs, so
a passkey can never be bound to someone else's account — always take `userId` from
the authenticated session, never from request input. In production, swap the
default in-memory `PasskeyStore` / `WebAuthnChallengeStore` for durable ones.
:::

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

For legacy **SAML 2.0** IdPs (ADFS, Shibboleth, or an IdP configured for SAML),
use the companion **`@basaltkit/auth-saml`** package — SP-initiated SSO built on the
vetted `@node-saml/node-saml` XML-DSig library, plugging into the same
`Auth.socialLogin`:

```ts
import { samlPlugin, samlRoutes } from '@basaltkit/auth-saml'

samlPlugin({ providers: [{ name: 'okta', entryPoint, idpCert, issuer, callbackUrl }] })
// routes: GET /auth/saml/:provider/login · POST …/acs · GET …/metadata
```

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

## Options reference

`authPlugin(options)` — every option of the `Auth` service except `hooks`, which
the plugin supplies:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `users` | `UserSource` | — (required) | Where accounts live. `MemoryUserSource` in dev; `auth-sqlite`/`auth-prisma`, or your own four methods over your tables |
| `secret` | `string` | — (required) | HS256 signing key for access tokens. Rejected empty, and rejected under 32 chars when `NODE_ENV=production` (`AUTH_WEAK_SECRET`) |
| `hasher` | `PasswordHasher` | `new ScryptPasswordHasher()` | Password hashing. Swap for an argon2id implementation without touching call sites |
| `sessions` | `SessionStore` | in-memory | Cookie/`x-session-id` sessions — swap for durability |
| `refreshTokens` | `RefreshTokenStore` | in-memory | Refresh-token families; in-memory means every redeploy logs everyone out |
| `tokens` | `AuthTokenStore` | in-memory | Email-verification and password-reset tokens |
| `mfa` | `MfaStore` | in-memory | TOTP enrollment state and recovery codes |
| `accessTtl` | `DurationInput` | `'15m'` | Access-token lifetime. Short by design — the refresh token is what carries the session |
| `refreshTtl` | `DurationInput` | `'30d'` | Refresh-token lifetime — effectively "how long until a user must log in again" |
| `sessionTtl` | `DurationInput` | `'30d'` | Server-side session lifetime |
| `verificationTtl` | `DurationInput` | `'24h'` | Email-verification link lifetime |
| `resetTtl` | `DurationInput` | `'1h'` | Password-reset link lifetime; keep it short |
| `loginThrottle` | `LoginThrottle \| false` | `new LoginThrottle()` (5 per 15m, per email) | Brute-force lockout per email. `false` disables it — tests only |
| `ipLoginThrottle` | `LoginThrottle \| false` | `new LoginThrottle({ maxAttempts: 50, windowMs: 900_000 })` | Per-IP budget that catches password *spraying* (one attempt across many accounts), which a per-email counter misses. Only applies when the caller passes the client ip — `authRoutes()` does |
| `enumerationSafeRegister` | `boolean` | `true` | Keeps `POST /auth/register` from revealing that an email already has an account. `false` restores `409 AUTH_EMAIL_TAKEN` |
| `tokenVersions` | `TokenVersionStore` | — (off) | Opt-in access-token **revocation**: tokens carry a `tv` claim that `resetPassword`/`revokeAllTokens` bump, killing outstanding tokens before their TTL. Costs one store read per authenticated request |
| `mfaEncryptionKey` | `string \| Buffer` | — (plaintext) | Encrypts TOTP secrets at rest with AES-256-GCM (`v1:` envelopes), so a database leak can't recover a live second factor. Existing plaintext rows keep working and are encrypted on next write |
| `mfaIssuer` | `string` | `'Basalt'` | Issuer name shown in the authenticator app |

`new LoginThrottle(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `maxAttempts` | `number` | `5` | Failed attempts allowed inside the window |
| `windowMs` | `number` | `900_000` (15m) | Rolling window; a successful login clears the counter |
| `clock` | `() => number` | `Date.now` | Injectable clock (tests) |

`apiKeysPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `store` | `ApiKeyStore` | in-memory | Where key hashes live — durable in production, or keys die on redeploy |
| `header` | `string` | `'x-api-key'` | Alternative header to `Authorization: Bearer mk_…` |
| `users` | `UserSource` | — | When set, a key carrying a `userId` also populates `ctx().user`, so scope-guarded routes can read the acting user |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |

`webauthnPlugin(options)` and its `config`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `verifier` | `WebAuthnVerifier` | — (required) | The crypto boundary you implement over `@simplewebauthn/server`, so the framework carries no WebAuthn dependency |
| `credentials` | `PasskeyStore` | `new MemoryPasskeyStore()` | Registered passkeys — swap for a durable store |
| `challenges` | `WebAuthnChallengeStore` | `new MemoryWebAuthnChallengeStore()` | Single-use ceremony challenges |
| `config.rpId` | `string` | — (required) | Relying Party ID — your registrable domain, e.g. `'example.com'` |
| `config.rpName` | `string` | — (required) | Human-readable name shown in the OS prompt |
| `config.origin` | `string \| string[]` | — (required) | Expected origin(s), e.g. `'https://example.com'` |
| `config.challengeTtlMs` | `number` | `300_000` (5m) | How long a challenge stays usable |
| `config.userVerification` | `'required' \| 'preferred' \| 'discouraged'` | `'preferred'` | Whether the authenticator must verify the user (PIN/biometric) |
| `config.timeoutMs` | `number` | `60_000` | Ceremony timeout advertised to the browser |
| `config.pubKeyCredParams` | `PublicKeyParam[]` | ES256 + RS256 | Override the accepted signature algorithms |

`oauthPlugin(options)` and `oauthRoutes(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `providers` | `OAuthProvider[]` | — (required) | `googleProvider()`, `githubProvider()`, `oidcProvider()` / `discoverOidcProvider()` — one entry per IdP |
| `secret` | `string` | — (required) | HMAC key that signs the CSRF `state`; typically the same `APP_SECRET` |
| `stateTtlMs` | `number` | `600_000` (10m) | How long a signed `state` stays valid — the window for completing the redirect |
| `fetch` | `typeof fetch` | global `fetch` | Injected HTTP client (tests) |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |
| `callbackBaseUrl` (routes) | `string` | — (required) | Public base URL of your app; the redirect URI is `${callbackBaseUrl}/auth/oauth/:provider/callback` and must be registered with each provider |
| `successRedirect` (routes) | `string` | — (JSON response) | Bounce the browser here with `#access_token=…&refresh_token=…` instead of returning JSON — the SPA flow |

Register `oauthPlugin` **after** `authPlugin`: the service resolves `AUTH` to log
users in.

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 | Unknown email or wrong password — deliberately indistinguishable, and equal-cost |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 | `auth.register()` on an existing email (the *route* stays enumeration-safe unless you set `enumerationSafeRegister: false`) |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 | A `meta.auth` route (or an MFA route) ran with no `ctx().user` |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 | The presented **access token** is malformed/wrongly signed, or past its TTL |
| `AuthTokenInvalidError` | `AUTH_TOKEN_INVALID` | 400 | A verification or reset **link** token is unknown, already used, or expired |
| `RefreshInvalidError` | `AUTH_REFRESH_INVALID` | 401 | Refresh token unknown, revoked or expired |
| `RefreshReusedError` | `AUTH_REFRESH_REUSED` | 401 | A **consumed** refresh token came back — theft indicator; the whole family is revoked |
| `MfaRequiredError` | `AUTH_MFA_REQUIRED` | 401 | Password correct, MFA enabled, no `mfaCode` supplied. Not counted as a failed attempt |
| `MfaInvalidCodeError` | `AUTH_MFA_INVALID` | 401 | Wrong TOTP or recovery code — this **does** count toward the throttle |
| `MfaNotEnrolledError` | `AUTH_MFA_NOT_ENROLLED` | 400 | Activating/disabling MFA with no enrollment in progress |
| `AccountLockedError` | `AUTH_LOCKED` | 429 | The per-email or per-IP failed-login budget is spent; carries `retryAfterMs` |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 | Your `UserSource` has no `update()` — required for verification and reset |
| `WeakJwtSecretError` | `AUTH_WEAK_SECRET` | boot | `secret` missing, or shorter than 32 chars under `NODE_ENV=production` |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 | A `meta.scopes` route was called without an API key holding that scope (or `*`) |
| `ApiKeyForbiddenError` | `AUTH_APIKEY_NOT_FOUND` | 404 | `DELETE /apikeys/:id` for a key outside the caller's tenant/user scope — a 404, never a 403, so key ids can't be probed |
| `WebAuthnChallengeError` | `WEBAUTHN_CHALLENGE_INVALID` | 400 | The passkey challenge expired or was already used (they are single-use) |
| `WebAuthnVerificationError` | `WEBAUTHN_VERIFICATION_FAILED` | 400 | The verifier rejected the browser's response |
| `WebAuthnSubjectMismatchError` | `WEBAUTHN_SUBJECT_MISMATCH` | 403 | `finishRegistration` got a different `userId` than the challenge was issued for |
| `PasskeyNotFoundError` | `PASSKEY_NOT_FOUND` | 404 | No stored credential matches the presented id |
| `PasskeyClonedError` | `PASSKEY_CLONED` | 401 | The signature counter did not increase — the authenticator may be cloned |
| `PasskeyExistsError` | `PASSKEY_EXISTS` | 409 | That credential is already registered |
| `OAuthProviderUnknownError` | `AUTH_OAUTH_UNKNOWN_PROVIDER` | 404 | `:provider` isn't in the `providers` array |
| `OAuthStateInvalidError` | `AUTH_OAUTH_STATE_INVALID` | 400 | The CSRF `state` is missing, tampered with, or older than `stateTtlMs` |
| `OAuthExchangeError` | `AUTH_OAUTH_EXCHANGE_FAILED` | 502 | The provider rejected the code exchange or the profile fetch failed |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.auth` and `authPlugin` isn't registered |

- **Every request is anonymous even with a valid `Authorization` header** — check
  the bearer isn't `mk_`-prefixed (those belong to `apiKeysPlugin`), and that
  `authPlugin` is registered *before* the adapter plugin so its enricher is in the
  pipeline.
- **`401 AUTH_REQUIRED` on a route you thought was public** — `meta.auth` was left
  on it. And if the app refuses to *boot* with `HTTP_UNGUARDED_ROUTE_META`, it is
  the opposite problem: the meta is there, the plugin isn't.
- **`AUTH_REFRESH_REUSED` right after a normal-looking login** — two clients (or a
  retried request) refreshed with the same token. Rotation is single-use per
  token; serialize refreshes on the client, don't retry them blindly.
- **Everyone is logged out after a redeploy** — the `Memory*` stores are per
  process. Move `refreshTokens`/`sessions` to `auth-sqlite` or `auth-prisma`.
- **`AUTH_UPDATE_UNSUPPORTED` on verification or reset** — your custom
  `UserSource` omits `update()`. It is optional for login, required for these.
- **`AUTH_LOCKED` for a user who typed the right password** — the *IP* budget can
  trip first under shared NAT or a load test. Tune `ipLoginThrottle`, and remember
  both throttles are in-process: with several replicas the effective budget is
  per replica.
- **`AUTH_WEAK_SECRET` only in production** — the length floor is enforced when
  `NODE_ENV=production`; a dev-length secret boots locally and fails on deploy.

## Events

| Hook | Payload | Typical use |
| --- | --- | --- |
| `auth:registered` | `{ user }` | Welcome email, provisioning |
| `auth:register_existing_email` | `{ email }` | The out-of-band "you already have an account" email — the signal the HTTP response deliberately withholds |
| `auth:login` · `auth:login_failed` | `{ user }` · `{ email }` | Audit trail, alerting |
| `auth:logout` | `{ user }` | Audit trail |
| `auth:verify_requested` · `auth:email_verified` | `{ user, token }` · `{ user }` | **Email the token** — it is never returned over HTTP |
| `auth:password_reset_requested` · `auth:password_reset` | `{ user, token }` · `{ user }` | **Email the token**; the second confirms the change |
| `auth:mfa_enabled` · `auth:mfa_disabled` | `{ user }` | Security notification |
| `auth:apikey_issued` · `auth:apikey_revoked` | `{ id, tenantId?, userId? }` · `{ id }` | Audit trail |

They are consumed for free by audit and notifications (see
[Packages](/reference/packages)). For the full end-to-end wiring — email
plumbing, teams and billing — see the
[account lifecycle cookbook](/cookbook/account-lifecycle).
