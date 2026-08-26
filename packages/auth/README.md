<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/auth

Complete authentication for Basalt applications: user registration and login, JWT tokens with secure renewal, sessions, email verification, password recovery, two-factor authentication (MFA/TOTP), social login (Google, GitHub, or any OpenID Connect provider), and API keys — all with ready-to-use HTTP routes.

You need this module whenever your application has users who log in.

## What this module solves

When an application has user accounts, it needs to answer two questions on every request: "who are you?" (authentication) and "how do you prove it?". Doing this by hand is difficult and dangerous — storing passwords securely, generating and validating **tokens** (small digital "tickets" that prove identity without sending the password on every request), preventing brute-force attacks, and so on.

`@basaltkit/auth` handles all of this for you. Passwords are never stored in plain text — only an irreversibly scrambled version (**hash**, using the scrypt algorithm). Login returns a pair of tokens: an **access token** (short-lived JWT, 15 minutes by default, sent with every request) and a **refresh token** (long-lived, 30 days, used only to obtain a new access token). If a refresh token is used twice — a typical sign of theft — the entire token "family" is automatically revoked.

It also includes, with nothing extra to install: account lockout after too many failed attempts, email verification and password recovery via single-use links, MFA via authenticator app (Google Authenticator, etc.) with recovery codes, social login (OAuth 2.0 / OpenID Connect), and API keys for programmatic access (scripts, integrations).

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

### Passkeys — WebAuthn (`webauthnPlugin`)

Passkeys let users sign in with Face ID / Touch ID / a security key — no password.
The framework drives the whole **ceremony** (challenges, browser options, credential
storage, single-use challenges, the clone-detection counter check) and delegates
only the **cryptographic verification** to a small `WebAuthnVerifier` you implement
over [`@simplewebauthn/server`](https://simplewebauthn.dev) — so `@basaltkit/auth`
never depends on a WebAuthn crypto library.

```ts
import { webauthnPlugin, type WebAuthnVerifier } from '@basaltkit/auth'
import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'

const verifier: WebAuthnVerifier = {
  async verifyRegistration(input) {
    const v = await verifyRegistrationResponse({
      response: input.response as never,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: input.requireUserVerification,
    })
    if (!v.verified || !v.registrationInfo) return { verified: false }
    const { credential } = v.registrationInfo
    return {
      verified: true,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: input.response && (input.response as any).response?.transports,
      },
    }
  },
  async verifyAuthentication(input) {
    const v = await verifyAuthenticationResponse({
      response: input.response as never,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: input.requireUserVerification,
      credential: {
        id: input.credential.id,
        publicKey: Buffer.from(input.credential.publicKey, 'base64url'),
        counter: input.credential.counter,
      },
    })
    return { verified: v.verified, newCounter: v.authenticationInfo?.newCounter ?? input.credential.counter }
  },
}

app.use(webauthnPlugin({
  config: { rpId: 'example.com', rpName: 'Example', origin: 'https://example.com' },
  verifier,
  // credentials / challenges default to in-memory — pass durable stores in prod
}))
```

Then drive the four steps from your routes, resolving the service from the `WEBAUTHN`
token. The **sessionKey** ties a challenge to the current session (use the user id,
or a session id for logged-out login):

```ts
import { WEBAUTHN } from '@basaltkit/auth'
const passkeys = container.get(WEBAUTHN)

// Register a passkey for a signed-in user
const options = await passkeys.startRegistration(sessionKey, { id: user.id, name: user.email })
// → send options to @simplewebauthn/browser's startRegistration(), post the result back:
await passkeys.finishRegistration(sessionKey, user.id, browserResponse, 'MacBook')

// Sign in with a passkey (usernameless: omit the userId)
const authOptions = await passkeys.startAuthentication(sessionKey)
const { userId } = await passkeys.finishAuthentication(sessionKey, browserResponse)
// → mint your session/JWT for userId as usual
```

> **Security:** the registration challenge is bound to the `user.id` you pass to
> `startRegistration`; `finishRegistration` refuses (`WEBAUTHN_SUBJECT_MISMATCH`) if the
> `userId` doesn't match, so a passkey can never be bound to another account. Always
> derive `userId` from the authenticated session, never from request input. A duplicate
> credential id is rejected (`PASSKEY_EXISTS`) rather than overwriting an existing one.

`finishAuthentication` looks the credential up by id, verifies it, checks the
signature counter **increased** (a non-increasing counter throws `PasskeyClonedError`),
and persists the new counter. Use `passkeys.list(userId)` / `passkeys.remove(id)`
for a "manage devices" screen.

### Social login (OAuth)

Sign in with Google, GitHub, or any OpenID Connect provider via the OAuth 2.0
authorization-code flow — no SDK, and cookieless (the CSRF `state` is HMAC-signed
and stateless). Register `oauthPlugin` with your providers and `oauthRoutes` with
your app's **base URL**:

```ts
import {
  authPlugin, authRoutes, oauthPlugin, oauthRoutes, googleProvider, githubProvider,
} from '@basaltkit/auth'
import { fastifyPlugin } from '@basaltkit/fastify'

createApp({
  plugins: [
    authPlugin({ users, secret: process.env.AUTH_SECRET! }),
    oauthPlugin({
      secret: process.env.AUTH_SECRET!, // signs the stateless `state`
      providers: [
        googleProvider({ clientId: env.GOOGLE_ID, clientSecret: env.GOOGLE_SECRET }),
        githubProvider({ clientId: env.GITHUB_ID, clientSecret: env.GITHUB_SECRET }),
      ],
    }),
    fastifyPlugin({
      routes: [
        ...authRoutes(),
        // callbackBaseUrl is your app's BASE url — the module appends
        // /auth/oauth/:provider/callback itself.
        ...oauthRoutes({ callbackBaseUrl: 'https://app.example.com' }),
      ],
    }),
  ],
})
```

Two routes are added per provider:

- `GET /auth/oauth/:provider` → 302 to the provider's consent screen.
- `GET /auth/oauth/:provider/callback` → verifies the `state`, exchanges the code,
  and logs the user in. Returns JSON `{ user, accessToken, refreshToken }`; pass
  `successRedirect` to `oauthRoutes` to bounce the browser back to your SPA with
  the tokens in the URL fragment instead.

**Register the redirect URI with each provider exactly** as
`${callbackBaseUrl}/auth/oauth/:provider/callback` — e.g.
`https://app.example.com/auth/oauth/github/callback`. It must match
character-for-character, or the provider rejects it with *"redirect_uri is not
associated with this application"*.

New accounts are created **passwordless** and a provider-verified email flips
`emailVerified`. Accounts are matched by email, so only trust providers that
return a **verified** address (Google and the built-in GitHub driver both do).
`Auth.socialLogin(email)` is the underlying primitive for custom providers.

**Enterprise SSO (OIDC):** any OpenID Connect IdP (Okta, Entra ID, Auth0,
Keycloak…) plugs in via `oidcProvider({ clientId, clientSecret, authorizationUrl,
tokenUrl, userinfoUrl })`, or let `discoverOidcProvider(issuerUrl, keys)` read the
endpoints from the IdP's `.well-known/openid-configuration`.

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
| `socialLogin(email, { emailVerified? })` | Find-or-create a passwordless account for an OAuth/OIDC identity; returns `{ user, tokens }`. |

### Ready-made routes

- `authRoutes()`: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. These are regular routes — you can omit or replace any of them.
- `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id` (all require login; scoped to the current tenant/user).
- `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable`.
- `oauthRoutes({ callbackBaseUrl, successRedirect? })`: `GET /auth/oauth/:provider` and `GET /auth/oauth/:provider/callback` for each configured provider.

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
| `AUTH`, `API_KEYS`, `OAUTH` | Injection tokens: `container.get(AUTH)` returns the `Auth` instance; `OAUTH` returns the `OAuth` instance. |
| `oauthPlugin`, `oauthRoutes` | Social-login plugin (`{ secret, providers }`) and its routes (`{ callbackBaseUrl, successRedirect? }`). |
| `googleProvider`, `githubProvider`, `oidcProvider`, `discoverOidcProvider` | OAuth 2.0 / OpenID Connect providers. Each takes `{ clientId, clientSecret, scopes? }`. |
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
| `OAuthProviderUnknownError` | `AUTH_OAUTH_UNKNOWN_PROVIDER` | 404 |
| `OAuthStateInvalidError` | `AUTH_OAUTH_STATE_INVALID` | 400 |
| `OAuthExchangeError` | `AUTH_OAUTH_EXCHANGE_FAILED` | 502 |

## Common issues and solutions (FAQ)

**"Users disappear when I restart the server."** You're using `MemoryUserSource` (and in-memory stores). Implement `UserSource` (and the other stores) over your database.

**"401 AUTH_TOKEN_EXPIRED shortly after login."** The access token lasts 15 minutes by design. The client should call `POST /auth/refresh` with the refresh token to get a new pair — don't increase `accessTtl` to long values.

**"401 AUTH_REFRESH_REUSED."** The same refresh token was used twice. Each refresh returns a new token that replaces the previous one; always keep the most recent one. If this happens without a client bug, it may indicate token theft — the user will need to log in again (intentional behavior).

**"AUTH_UPDATE_UNSUPPORTED on email verification / reset."** Your `UserSource` doesn't implement the optional `update()` method. It's required for these two flows.

**"The email with the link is never sent."** The module doesn't send emails — it emits the `auth:verify_requested` and `auth:password_reset_requested` hooks with the token; your application listens to them and sends the email.

**"429 AUTH_LOCKED in tests."** The throttle is active by default. In tests, pass `loginThrottle: false`.

**"My API key doesn't work with authPlugin."** Correct: bearers prefixed with `mk_` are ignored by `authPlugin` and handled by `apiKeysPlugin` — register both.

**"OAuth: redirect_uri is not associated with this application."** Your `callbackBaseUrl` must be the app's **base URL** (`https://app.example.com`), *not* the full callback path — the module appends `/auth/oauth/:provider/callback` itself. Passing the full callback URL doubles the path so it no longer matches what you registered. Register exactly `${callbackBaseUrl}/auth/oauth/:provider/callback` with the provider.

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
