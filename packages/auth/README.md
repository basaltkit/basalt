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

For browser clients, the same login response also sets an `HttpOnly` session
cookie named `basalt_session`. Browsers send it automatically on same-origin
requests, so browser code does not need to read or store the JWT in
`localStorage`:

```bash
curl -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'

curl -b cookies.txt http://localhost:3000/auth/me
```

The cookie defaults to `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in
production — anything but an explicit `NODE_ENV=development` or `test` (an
unset `NODE_ENV` counts as production, as in `@basaltkit/env`). The same rule
gates the 32-character minimum on `secret` (`AUTH_WEAK_SECRET`). A cookie whose
value cannot be decoded (malformed percent-encoding) is ignored: the request is
simply anonymous. Customize its public attributes when mounting the plugin:

```ts
authPlugin({
  users,
  secret: process.env.AUTH_SECRET!,
  sessionCookie: {
    name: 'app_session',
    path: '/app',
    sameSite: 'Strict',
    secure: true,
  },
})
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
import type { UserSource, AuthUser, UserPatch, NewUser } from '@basaltkit/auth'

const users: UserSource = {
  async findByEmail(email) { /* SELECT ... WHERE email = ? */ return null },
  async findById(id) { /* SELECT ... WHERE id = ? */ return null },
  async create(data: NewUser) {
    // data = { email, passwordHash, emailVerified? } — the hash is already computed;
    // persist emailVerified (omitted = false) with the row
    return { id: 'new-id', email: data.email, passwordHash: data.passwordHash, emailVerified: data.emailVerified === true }
  },
  // Optional, but required for email verification and password reset:
  async update(id, patch: UserPatch) { /* UPDATE ... */ return null },
  // Optional: bulk contact lookup (see below).
  async findByIds(ids) { /* SELECT id, email, email_verified WHERE id IN (...) */ return [] },
}
```

| Method | Required? | Returns | Purpose |
|---|---|---|---|
| `findByEmail(email)` | Yes | `AuthUser \| null` | Sign-in and registration lookups. Emails are case-insensitive identities. |
| `findById(id)` | Yes | `AuthUser \| null` | Resolving the user behind a token, session or API key. |
| `create({ email, passwordHash, emailVerified? })` | Yes | `AuthUser` | Registration; the hash arrives already computed. `emailVerified: true` comes only from trusted flows (`register(…, { emailVerified: true })`, a provider-verified social login) and must be persisted with the row. A source that drops it is patched through `update()`; without `update()`, `register(…, { emailVerified: true })` throws `AUTH_UPDATE_UNSUPPORTED` and a social login keeps the account unverified (still linked and signed in). |
| `update(id, patch)` | No | `AuthUser \| null` | Email verification and password reset need it (`AUTH_UPDATE_UNSUPPORTED` without it). |
| `findByIds(ids)` | No | `PublicUser[]` | **Bulk contact lookup** — see below. |

#### `findByIds` — one lookup instead of N

`findById` resolves one account at a time, which pushes anything that needs the
*contact details of a group* ("email every admin of this tenant") into either N
round trips or — worse — reading the auth tables directly from application code,
coupling the product to the auth schema.

`findByIds` is the bulk counterpart, and its contract is deliberately narrower
than `findById`'s:

- it resolves **`PublicUser`**, never `AuthUser` — a directory lookup has no
  business carrying a password hash, and the shipped drivers do not even
  `SELECT` the credential columns;
- one entry per **found** id, **in the order of `ids`**; ids with no account are
  omitted, so the result may be shorter than the input;
- duplicate ids collapse to one entry, and an empty list resolves to `[]`
  without touching the database.

It is optional: stores written before it keep compiling, and callers fall back
to one `findById` per id. `@basaltkit/teams` does exactly that — pass the same
`UserSource` to `teamsPlugin({ users })` and `teams.roleRecipients(tenantId,
'admin')` returns the admins' contacts, taking the batched path automatically
when your driver has one.

```ts
const contacts = await users.findByIds?.(['u1', 'u2', 'ghost'])
// → [{ id: 'u1', email: 'ada@acme.test', emailVerified: true }, { id: 'u2', ... }]
```

The shipped drivers (`@basaltkit/auth-prisma`, `@basaltkit/auth-sqlite`) and
`MemoryUserSource` all implement it; the SQL ones chunk the id list so a large
tenant can't exceed the driver's bind-parameter limit.

### Register, login, and logout (by code)

All operations are also available programmatically through the `Auth` class:

```ts
import { Auth, MemoryUserSource } from '@basaltkit/auth'

const auth = new Auth({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }) // >= 32 chars in production

const user = await auth.register('ada@example.com', 'secretpassword1')
const { tokens } = await auth.login('ada@example.com', 'secretpassword1')
const renewed = await auth.refresh(tokens.refreshToken) // new token pair
await auth.revoke(renewed.refreshToken) // logout: invalidates the token family
```

### Protecting routes

`authPlugin` automatically registers:

- An **enricher** that reads the `Authorization: Bearer <jwt>`, the configured session cookie, or `x-session-id` and places the user in `ctx().user` (of type `PublicUser` — never includes the password hash).
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
3. From then on, `POST /auth/login` requires the extra `mfaCode` field (TOTP code or a recovery code). Correct password without a code → `AUTH_MFA_REQUIRED` error (counted by the login throttle — see [Brute-force lockout](#brute-force-lockout-loginthrottle)).
4. `GET /auth/mfa/status` and `POST /auth/mfa/disable` (with `{ code }`) complete the cycle.

**Requiring MFA.** `authPlugin({ requireMfa: true })` — or a policy
`requireMfa: (user, context) => boolean | Promise<boolean>` — refuses every
authenticated request whose credential was not obtained with a second factor:
`403 AUTH_MFA_ENROLLMENT_REQUIRED` (no MFA yet: enrol, then sign in again) or
`403 AUTH_MFA_REQUIRED` (sign in again with a code). Routes with
`meta.mfa: false` are exempt — all of `authRoutes()` and MFA
enroll/activate/status. `meta: { mfa: true }` requires MFA on one route
(step-up) even without the policy. Tokens carry an `amr` claim (`['pwd']`,
`['pwd', 'mfa']`, `['fed', …]` for social login), refreshes keep it, the
session cookie carries it HMAC-signed, and the request exposes it as
`ctx().amr`. API-key requests are not subject to the policy. Off by default.
Listing surfaces (MCP `tools/list`) hide `meta.mfa: true` routes — and, under
`requireMfa: true`, every authenticated route — from a session without `'mfa'` in
`ctx().amr`, through a side-effect-free `http:route-visibility` check. A
`requireMfa` function is never called for a listing.

**Encrypting secrets at rest.** `authPlugin({ mfaEncryption: { keys: [{ id, key }] } })`
(or the shorthand `mfaEncryptionKey`) stores TOTP secrets as `bka2.<keyId>.…`
envelopes: AES-256-GCM, HKDF-SHA256-derived keys (≥ 32 bytes of material), bound
to the user as associated data. The first key of the ring seals, the others stay
readable (rotation); `auth.reencryptMfaSecret(userId)` moves a row to the active
key. A value that is not an envelope sealed for that user is refused
(`AUTH_SECRET_UNREADABLE`) — a database write cannot swap in a plaintext secret.
Old `v1:` envelopes and plaintext rows are read only with an explicit
`legacy: { v1Keys: [oldKey], plaintext: true }`, for the migration window.
`SecretBox` is exported for other secrets.

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
signature counter **increased** (a non-increasing counter throws `PasskeyClonedError`;
a non-integer counter from the verifier is refused), and persists the new counter
with `PasskeyStore.compareAndSetCounter(id, expected, next, lastUsedAt)` — a
conditional update, so two concurrent assertions presenting the same counter (a
cloned authenticator racing the genuine one) cannot both pass: the loser gets
`PasskeyClonedError`. A custom store must implement it (`PASSKEY_STORE_OUTDATED`
at construction otherwise); `@basaltkit/auth-sqlite` and `@basaltkit/auth-prisma`
ship durable `passkeys` stores.
When `startAuthentication(sessionKey, userId)` names a user (step-up,
re-authentication), only **that user's** passkey satisfies the challenge — any
other account's passkey throws `WEBAUTHN_SUBJECT_MISMATCH`.

Use `passkeys.list(userId)` / `passkeys.remove(userId, credentialId)` for a "manage
devices" screen. `remove` only deletes a passkey that belongs to `userId` (an unknown
or foreign id throws `PASSKEY_NOT_FOUND`), so pass the id of the **authenticated**
user, never one from the request.

> **User verification:** the default `userVerification: 'preferred'` lets an
> authenticator without a PIN/biometric sign, so the assertion proves possession
> only. When a passkey is the only factor (passwordless login), set
> `userVerification: 'required'`.

### Social login (OAuth)

Sign in with Google, GitHub, or any OpenID Connect provider via the OAuth 2.0
authorization-code flow — no SDK. The flow is bound to the browser that started
it (an HttpOnly binding cookie whose hash is in the HMAC-signed, single-use
`state`), and the code exchange uses PKCE (S256) plus an OIDC `nonce`. Register `oauthPlugin` with your providers and `oauthRoutes` with
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
      secret: process.env.AUTH_SECRET!, // signs the `state`, derives PKCE verifier + nonce
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

- `GET /auth/oauth/:provider` → sets the binding cookie, 302 to the provider's consent screen.
- `GET /auth/oauth/:provider/callback` → verifies the `state` against the cookie, exchanges the code,
  and logs the user in. Returns JSON `{ user, accessToken, refreshToken }`; pass
  `successRedirect` to `oauthRoutes` to bounce the browser back to your SPA with
  the tokens in the URL fragment instead.

**Register the redirect URI with each provider exactly** as
`${callbackBaseUrl}/auth/oauth/:provider/callback` — e.g.
`https://app.example.com/auth/oauth/github/callback`. It must match
character-for-character, or the provider rejects it with *"redirect_uri is not
associated with this application"*.

New accounts are created **passwordless** and a provider-verified email flips
`emailVerified`. Logins are bound to the provider's **subject**: the first login
of a provider account records an account link (provider + `sub` → account) in the
`accountLinks` store (`authPlugin({ accountLinks })`, durable ones in
`auth-sqlite` / `auth-prisma`). Once linked, an email change at the IdP still
reaches the same account, and a different subject of that provider asserting the
account's email is refused (`AccountLinkConflictError`, 409) unless
`oauthPlugin({ subjectConflict: 'link' })`. A first login links an **existing**
account only when the provider verified the email (`SocialLinkRefusedError`
otherwise); an existing account that had never verified its own email has its
password, sessions, refresh tokens, MFA and account links revoked before it is
adopted; an account with MFA enabled requires the code (`MfaRequiredError`)
unless `oauthPlugin({ mfa: 'skip' })` is set for an IdP that enforces its own
MFA. `Auth.socialLogin(email, { emailVerified, identity: { provider, subject } })`
is the underlying primitive for custom providers.

**Enterprise SSO (OIDC):** any OpenID Connect IdP (Okta, Entra ID, Auth0,
Keycloak…) plugs in via `oidcProvider({ name, clientId, clientSecret, authorizeUrl,
tokenUrl, userInfoUrl, issuer? })`, or let `await discoverOidcProvider({ name, issuer,
clientId, clientSecret })` read the endpoints from the IdP's
`.well-known/openid-configuration` (the document's `issuer` must equal yours and every
endpoint must be `https:` — plain `http:` only to a loopback host).

**Restrict each enterprise IdP to its email domains.** A customer's IdP admin
decides which emails it asserts as verified; without a restriction, Acme's IdP could
assert `ceo@globex.com` and log into Globex's CEO account (any verified email links
to the existing account). Pass `allowedEmailDomains`:

```ts
oidcProvider({ name: 'acme', /* …endpoints, keys… */ allowedEmailDomains: ['acme.com'] })
await discoverOidcProvider({ name: 'globex', issuer, clientId, clientSecret, allowedEmailDomains: ['globex.com'] })
```

A login for any other domain fails with `AUTH_OAUTH_EXCHANGE_FAILED` before an
account is looked up (exact, case-insensitive match; list subdomains explicitly). With
**more than one provider configured**, every `oidcProvider` / `discoverOidcProvider`
entry must declare `allowedEmailDomains` or `allowAnyEmailDomain: true` (only for an
IdP you fully control) — otherwise `OAuth` refuses to start with
`AUTH_OAUTH_PROVIDER_CONFIG`. Google and GitHub are not affected (they only assert
emails they verified themselves); any custom `OAuthProvider` can opt in with
`enterprise: true` or set `allowedEmailDomains` directly.

Accounts are matched by **email**, not by the provider's `subject`: a verified email
from any configured provider logs into the account holding it. Keep that in mind
when you add a provider — the domain allowlist is what scopes it.

**Provider replies are validated:** a profile without a string `sub`/`email` (or an
email that is not a single-`@` address) fails the login; an `openid` flow must return
an `id_token` whose `nonce`, `aud` (your client id), `exp` and — when the provider
declares an `issuer` — `iss` match; a non-JSON token-endpoint reply is an exchange
error; every provider call has a deadline (`oauthPlugin({ timeoutMs })`, default 10 s).
`oauthRoutes` carry `meta.rateLimit` (10 per minute per ip and route by default,
enforced by the http `securityPlugin`; `oauthRoutes({ rateLimit: false })` removes it).

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

`apiKeysPlugin` claims the `scopes` key in the adapters' boot-time guarded-meta check, so a route declaring `meta.scopes` **without** the plugin registered fails loud at boot (`UnguardedRouteMetaError`) instead of serving unchecked.

The key is presented in the `Authorization: Bearer mk_live_...` or `x-api-key` header — one of them: a request carrying two **different** keys (one in each) is refused with 400 `AUTH_APIKEY_AMBIGUOUS` rather than letting one silently win. A **scope** is a granular permission on the key (e.g. `reports:read`); `*` means all. After authenticating, `ctx().apiKey` contains `{ id, scopes, tenantId?, userId? }`.

The guard enforces, on every key-authenticated request: **tenant binding** (a key
issued in a tenant is refused with `403 AUTH_APIKEY_TENANT_MISMATCH` on any request
resolving another tenant or none; tenantless keys are refused on tenant-scoped
requests unless `allowTenantlessKeys: true`), **scopes as an upper bound** (a key
without `*` is refused on `meta.auth`/`can`/`teamRole`/`audience` routes that do not
declare `meta.scopes`; opt out with `allowNarrowKeysOnUnscopedRoutes: true`) and
**session-only routes** (`meta.apiKey: false` refuses every key with
`403 AUTH_APIKEY_NOT_ALLOWED` — `apiKeyRoutes()` and `mfaRoutes()` declare it).
The plugin also registers a side-effect-free `http:route-visibility` check, so
listing surfaces (MCP `tools/list`) hide `meta.scopes` routes from callers whose key
does not hold every scope, `meta.apiKey: false` routes from key holders, and identity-gated routes without
`meta.scopes` from narrow keys (no `*`). A listing emits no `auth:apikey_rejected`.

**Rate limits and OpenAPI.** With `securityPlugin({ rateLimit })` from `@basaltkit/http`,
`meta.rateLimit: { …, key: 'apiKey' }` budgets each verified key separately (an invalid
key never gets a bucket of its own), and `rateLimit.prefixes` lifts the per-IP ceiling for
an API's paths. `openapiPlugin` advertises `meta.scopes` routes with an `apiKeyAuth`
scheme and `x-required-scopes`; if you change `header` here, pass the same one as
`openapiPlugin({ apiKey: { header } })`.

For machine clients: `rejectInvalid: true` answers a presented key that does not
verify with `401 AUTH_APIKEY_INVALID` and `WWW-Authenticate: Bearer
error="invalid_token"` (default: the request continues as anonymous), and
`touchEveryMs` (default 60 s; `0` = every request) throttles `lastUsedAt` writes.
`auth:apikey_rejected` carries the display `prefix` and `ip` of an invalid key,
never the secret; `@basaltkit/audit` does not record it by default. A refusal of
a key that verified (`tenant_mismatch`, `not_allowed`, `scope`) is also emitted
as `auth:apikey_refused` (`{ id, reason, tenantId? }`), which the audit records
by default.

### Brute-force lockout (LoginThrottle)

Active by default: 5 failed attempts per email within a 15-minute window → `AUTH_LOCKED` error (HTTP 429). A successful login clears the counter.

**`AUTH_MFA_REQUIRED` counts as an attempt.** On an MFA account, that answer is only given for the *right* password, so it is a password oracle (the standard two-step MFA login has the same property). To keep it from allowing unthrottled guessing, it spends the per-account and per-IP budgets exactly like a wrong password. A user who then signs in with the code clears the account counter; the IP slot of the first step expires with the window, so under a shared NAT with many MFA users, size `ipLoginThrottle` accordingly.

```ts
import { authPlugin, LoginThrottle, MemoryUserSource } from '@basaltkit/auth'

authPlugin({
  users: new MemoryUserSource(),
  secret: process.env.AUTH_SECRET!,
  loginThrottle: new LoginThrottle({ maxAttempts: 3, windowMs: 10 * 60_000 }),
  // or loginThrottle: false to disable (not recommended)
})
```

Counters live in memory per process by default. For several replicas, share
them: `authPlugin({ throttleStore: new RedisThrottleStore(redis) })` backs the
login/MFA, per-IP and email-request throttles with one atomic Redis script per
attempt. `redis` is any ioredis-compatible client — only `eval` and `del` are
used, no Redis dependency. Implement `ThrottleStore` for another backend.

The in-memory store is bounded (`maxEntries`, default 100 000): when full it
sweeps expired entries, then evicts the oldest *unlocked* ones — a flood of junk
identifiers cannot flush a locked account out of the store and hand the
attacker a fresh budget. Only when every tracked entry is locked does the oldest
lock go (the memory bound is absolute).

### Hooks (events)

The application can react to authentication events: `auth:registered`, `auth:register_existing_email`, `auth:register_refused` (a registration policy refused a new account: `{ email, tenantId?, source: 'register' | 'social' }`), `auth:login`, `auth:login_failed`, `auth:logout`, `auth:verify_requested`, `auth:email_verified`, `auth:password_reset_requested`, `auth:password_reset`, `auth:mfa_enabled`, `auth:mfa_disabled`, `auth:apikey_issued`, `auth:apikey_revoked`.

## API reference

### `authPlugin(options)` and the `Auth` class

Options (`AuthOptions` / `AuthPluginOptions` — the plugin accepts the same minus `hooks`):

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `users` | `UserSource` | Yes | — | Where users come from (your DB). Implement the optional `findByIds` for batched contact lookups. |
| `secret` | `string` | Yes | — | Secret that signs the JWTs (HS256). |
| `hasher` | `PasswordHasher` | No | `ScryptPasswordHasher` | Password hashing algorithm. |
| `sessions` | `SessionStore` | No | `MemorySessionStore` | Session storage. |
| `refreshTokens` | `RefreshTokenStore` | No | `MemoryRefreshTokenStore` | Refresh token storage. `markUsed` must be a **compare-and-swap** — see below. |
| `accessTtl` | `DurationInput` | No | `'15m'` | Access token validity. |
| `refreshTtl` | `DurationInput` | No | `'30d'` | Refresh token validity. |
| `sessionTtl` | `DurationInput` | No | `'30d'` | Session validity (absolute). |
| `sessionIdleTtl` | `DurationInput` | No | — | Idle timeout: a session unused for longer is refused and deleted. Needs a session store with `touch` (memory, auth-sqlite, auth-prisma with `trackSessionActivity`); fails at boot otherwise. |
| `sessionCookie` | `SessionCookieOptions` | No | `basalt_session`, `HttpOnly`, `SameSite=Lax`, `Path=/` | Browser session cookie attributes. `Secure` defaults on unless `NODE_ENV` is explicitly `development`/`test`. A `__Host-`/`__Secure-` name implies `Secure` (and `Path=/` for `__Host-`); a contradicting value is emitted as configured with a boot warning, and is refused from the next major (`AUTH_SESSION_COOKIE_INVALID`). |
| `loginThrottle` | `LoginThrottle \| false` | No | active (5/15min) | Anti brute-force lockout; `false` disables it. |
| `throttleStore` | `ThrottleStore` | No | in-memory, per process | Counters of the default login / per-IP / email-request throttles — `RedisThrottleStore` for one budget across replicas. |
| `requireMfa` | `boolean \| (user, context) => boolean \| Promise<boolean>` | No | off | Plugin only. Require a sign-in with MFA on every authenticated route except `meta.mfa: false` ones. |
| `tokens` | `AuthTokenStore` | No | `MemoryAuthTokenStore` | Verification/reset tokens. `markUsed` must be a **compare-and-swap** — see below. |
| `verificationTtl` | `DurationInput` | No | `'24h'` | Email verification link validity. |
| `resetTtl` | `DurationInput` | No | `'1h'` | Password reset link validity. |
| `mfa` | `MfaStore` | No | `MemoryMfaStore` | Per-user MFA state. |
| `accountLinks` | `AccountLinkStore` | No | `MemoryAccountLinkStore` | OAuth/OIDC account links (provider + subject → user). `create` must be atomic on the pair. |
| `mfaEncryption` | `{ keys: SecretBoxKey[]; legacy? }` | No | — (plaintext) | Encrypts TOTP secrets at rest with a key ring; see *Encrypting secrets at rest*. |
| `mfaEncryptionKey` | `string \| Buffer` | No | — | Shorthand for a one-key ring (`id: 'default'`, ≥ 32 bytes). |
| `mfaIssuer` | `string` | No | `'Basalt'` | Name shown in the authenticator app. |
| `registerPolicy` | `RegisterPolicy` (`({ email, tenantId? }) => boolean \| Promise<boolean>`) | No | — (open) | Who may create a NEW account through `POST /auth/register` (refusal = same `202`, `auth:register_refused`) and the create branch of `socialLogin` (refusal = `RegistrationClosedError`). Logins into existing accounts and `register()` are never gated. `@basaltkit/teams`' `teamsInviteGate(teams)` = invite-only on tenant hosts. |
| `hooks` | `HookBus` | No | — | Only on the `Auth` class; the plugin injects it. |

`Auth` class methods:

| Method | Description |
|---|---|
| `register(email, password, { emailVerified? })` | Trusted, server-side creation; throws `EmailTakenError` if the email already exists; never gated by `registerPolicy`. `emailVerified: true` creates the account already verified (only for a flow that proved the address — never from a request body). |
| `registerSafely(email, password, { policy?, tenantId? })` | What `POST /auth/register` calls: enumeration-safe, asks the registration policy first (`policy: null` = open); never creates a verified account. |
| `login(email, password, mfaCode?)` | Returns `{ user, tokens, amr }`; applies throttle and MFA. |
| `attempt(email, password)` | Checks credentials without side effects; `null` on failure. |
| `refresh(refreshToken)` | New token pair; detects reuse and revokes the family. |
| `revoke(refreshToken)` | Logout for token-based clients. |
| `verifyAccess(accessToken)` | Validates the JWT and returns the claims. |
| `createSession(userId, { amr? })` / `sessionUser(sessionId)` / `sessionAuth(sessionId)` / `logout(sessionId)` | Cookie/header-based sessions; `amr` is carried HMAC-signed in the session id, `sessionAuth` returns `{ user, amr? }`. |
| `requestEmailVerification(email)` / `verifyEmail(token)` | Email verification. |
| `requestPasswordReset(email)` / `resetPassword(token, newPassword)` | Password recovery. |
| `enrollMfa(userId)` / `activateMfa(userId, code)` / `disableMfa(userId, code)` | MFA lifecycle. |
| `isMfaEnabled(userId)` / `mfaStatus(userId)` / `verifyMfaCode(userId, code)` | MFA state and verification. |
| `socialLogin(email, { emailVerified?, mfaCode?, mfa?, identity?, subjectConflict?, tenantId? })` | Find-or-create a passwordless account for an OAuth/OIDC identity; with `identity: { provider, subject }` the account link decides, otherwise it links to an existing account only with a provider-verified email; honours MFA; creating a new account asks `registerPolicy` (for `tenantId`, default `ctx().tenant?.id`) and is refused with `RegistrationClosedError`; returns `{ user, tokens }`. |
| `reencryptMfaSecret(userId)` | Re-seals a stored TOTP secret under the active `mfaEncryption` key (rotation / legacy migration): `'resealed'`, `'current'` or `'none'`. |

### Ready-made routes

- `authRoutes({ register?, password?, rateLimit? })`: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. These are regular routes — you can omit or replace any of them. `POST /auth/logout` takes an optional `{ refreshToken }`: with none (or no body) it ends the cookie / `x-session-id` session and expires the cookie — a cross-site cookie-only logout is refused (`403 AUTH_CSRF_REJECTED`). `register: 'open' | 'closed' | RegisterPolicy` sets who may sign up (default: the plugin's `registerPolicy`, open without one): `'closed'` answers a static `404 AUTH_REGISTRATION_CLOSED`; a refusing policy answers the same `202` as a success and creates nothing.
- Every `authRoutes()`, `mfaRoutes()` and `oauthRoutes()` route declares `meta.account: true` (about the caller, not a tenant's data — `@basaltkit/teams`' membership guard lets non-members through) and, except MFA disable, `meta.mfa: false` (reachable under `requireMfa`). `ACCOUNT_META` exports the pair for your own profile routes.
- `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id` (login session only — API keys are refused; scoped to the current tenant/user). `POST /apikeys` accepts an optional `expiresAt` Unix timestamp in milliseconds; expired keys are rejected and omitted from listings.
- `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable`.
- `oauthRoutes({ callbackBaseUrl, successRedirect?, bindingCookie?, rateLimit? })`: `GET /auth/oauth/:provider` and `GET /auth/oauth/:provider/callback` for each configured provider (rate-limited by default).

### `apiKeysPlugin(options)` and the `ApiKeys` class

Options (`ApiKeysPluginOptions`):

| Name | Type | Required? | Default | Description |
|---|---|---|---|---|
| `store` | `ApiKeyStore` | No | `MemoryApiKeyStore` | Key storage. |
| `header` | `string` | No | `'x-api-key'` | Alternative header to Bearer. Two different keys (Bearer + header) → 400 `AUTH_APIKEY_AMBIGUOUS`. |
| `users` | `UserSource` | No | — | If given, a key with `userId` also populates `ctx().user`. |
| `now` | `() => number` | No | `Date.now` | Injectable clock (tests). |

`ApiKeys` methods: `issue(input)` (returns `{ record, key }` — the plain-text key only appears here), `verify(presented)`, `list(filter)`, `get(id)`, `revoke(id)`. Helper `scopesSatisfy(granted, required)`.

### Exported utilities

| Export | Description |
|---|---|
| `signJwt(claims, { secret, expiresIn? })` / `verifyJwt(token, secret)` | Dependency-free HS256 JWT. Advanced. |
| `ScryptPasswordHasher` / `PasswordHasher` | Password hashing (scrypt, memory-hard). Advanced. A stored hash declaring more than N=2^20, r=32, p=16 (or 512 MiB) never verifies, so a tampered row cannot pin the CPU. |
| `LoginThrottle` (`maxAttempts` def. 5, `windowMs` def. 15 min, `store`, `namespace`, `clock`) | Anti brute-force. |
| `ThrottleStore` / `MemoryThrottleStore` / `RedisThrottleStore` (`RedisThrottleClient`: `eval` + `del`) | Where throttle counters live; Redis shares them across replicas. |
| `generateTotpSecret`, `totp`, `verifyTotp`, `otpauthUri`, `base32Encode`, `base32Decode` | TOTP primitives (RFC 6238). Advanced. |
| `publicUser(user)` | Converts `AuthUser` → `PublicUser` (removes the hash). |
| `UserSource.findByIds(ids)` | Optional bulk contact lookup: `PublicUser[]`, in the order of `ids`, missing ids omitted. Powers `@basaltkit/teams`' `roleRecipients`. |
| `AUTH`, `API_KEYS`, `OAUTH` | Injection tokens: `container.get(AUTH)` returns the `Auth` instance; `OAUTH` returns the `OAuth` instance. |
| `oauthPlugin`, `oauthRoutes` | Social-login plugin (`{ secret, providers }`) and its routes (`{ callbackBaseUrl, successRedirect? }`). |
| `googleProvider`, `githubProvider`, `oidcProvider`, `discoverOidcProvider` | OAuth 2.0 / OpenID Connect providers. Each takes `{ clientId, clientSecret, scopes? }`. |
| In-memory stores | `MemoryUserSource`, `MemorySessionStore`, `MemoryRefreshTokenStore`, `MemoryAuthTokenStore`, `MemoryApiKeyStore`, `MemoryMfaStore`, `MemoryAccountLinkStore`, `MemoryPasskeyStore` — dev/testing. |
| `SecretBox` | The at-rest envelope behind `mfaEncryption` (`seal` / `open` / `reseal` with a `{ purpose, subject }` context), for your own secrets. |

#### Single-use tokens are consumed with a compare-and-swap

`AuthTokenStore.markUsed` and `RefreshTokenStore.markUsed` return `Promise<boolean | void>`: mark the token used **only if it is still unused**, and return whether *this* call did it. `Auth.refresh()` treats `false` as reuse — it revokes the family and throws `AUTH_REFRESH_REUSED`; the verification/reset path treats it as a spent token (`AUTH_TOKEN_INVALID`).

This matters because `refresh()` reads the record, checks `usedAt`, then writes. With an unconditional `UPDATE … WHERE token = ?` those are two operations, so two concurrent refreshes of the same token — the legitimate client and a thief racing it — both read `usedAt = null` and both succeed, and reuse detection never fires. The shipped stores use a conditional update (`WHERE token = ? AND used_at IS NULL`, `where: { token, usedAt: null }`) and report the affected row count.

If you implement your own store, do the same. Returning `void` keeps the older read-then-write behaviour: it still compiles and runs, but without the race protection.

### Exported errors

| Error | Code | HTTP |
|---|---|---|
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | 401 |
| `EmailTakenError` | `AUTH_EMAIL_TAKEN` | 409 |
| `RegistrationClosedError` | `AUTH_REGISTRATION_CLOSED` | 404 (`authRoutes({ register: 'closed' })`, or a `registerPolicy` refused a first social / SSO login) |
| `RefreshInvalidError` / `RefreshReusedError` | `AUTH_REFRESH_INVALID` / `AUTH_REFRESH_REUSED` | 401 |
| `AuthRequiredError` | `AUTH_REQUIRED` | 401 |
| `TokenInvalidError` / `TokenExpiredError` | `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` | 401 |
| `AuthTokenInvalidError` (verification/reset links) | `AUTH_TOKEN_INVALID` | 400 |
| `UserUpdateUnsupportedError` | `AUTH_UPDATE_UNSUPPORTED` | 500 |
| `MfaRequiredError` / `MfaInvalidCodeError` / `MfaNotEnrolledError` | `AUTH_MFA_*` | 401/401/400 |
| `MfaStepUpRequiredError` / `MfaEnrollmentRequiredError` | `AUTH_MFA_REQUIRED` / `AUTH_MFA_ENROLLMENT_REQUIRED` | 403/403 |
| `AccountLockedError` | `AUTH_LOCKED` | 429 |
| `ScopeRequiredError` | `AUTH_SCOPE_REQUIRED` | 403 |
| `OAuthProviderUnknownError` | `AUTH_OAUTH_UNKNOWN_PROVIDER` | 404 |
| `OAuthStateInvalidError` | `AUTH_OAUTH_STATE_INVALID` | 400 |
| `OAuthExchangeError` | `AUTH_OAUTH_EXCHANGE_FAILED` | 502 (message kept for the log; the client gets `Bad gateway.`) |
| `OAuthProviderConfigError` | `AUTH_OAUTH_PROVIDER_CONFIG` | boot (several providers with an unrestricted enterprise IdP, an invalid domain entry, a duplicate name) |
| `ApiKeyAmbiguousError` | `AUTH_APIKEY_AMBIGUOUS` | 400 |
| `PasskeyNotFoundError` / `WebAuthnSubjectMismatchError` | `PASSKEY_NOT_FOUND` / `WEBAUTHN_SUBJECT_MISMATCH` | 404/403 |
| `PasskeyClonedError` / `PasskeyStoreOutdatedError` | `PASSKEY_CLONED` / `PASSKEY_STORE_OUTDATED` | 401 / boot |
| `AccountLinkConflictError` | `AUTH_ACCOUNT_LINK_CONFLICT` | 409 |
| `AccountEmailAmbiguousError` | `AUTH_EMAIL_AMBIGUOUS` | 500 (not exposed; several rows differ only in email case) |
| `SecretUnreadableError` / `SecretBoxKeyError` | `AUTH_SECRET_UNREADABLE` / `AUTH_SECRET_BOX_KEY_INVALID` | 500 / boot |

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
- **@basaltkit/tenancy** — defines `ctx().tenant`; API keys created within a tenant only work inside that tenant.
- **@basaltkit/teams** — the `meta.teamRole` guard combines `ctx().user` (auth) with `ctx().tenant` (tenancy).

## Security best practices

- **The `secret` is the vault's key.** Use a long, random value (e.g. `openssl rand -base64 48`), store it in an environment variable, and never put it in code or in git. If it leaks, anyone can forge tokens.
- **Always use HTTPS.** Plain-text tokens on an unencrypted connection can be intercepted.
- **Use the browser session cookie for browser UIs.** It is `HttpOnly` by default; keep JWTs out of `localStorage` and use same-origin requests so the browser sends the cookie automatically.
- **Don't increase `accessTtl`.** Short access tokens limit the damage from a stolen token; renewal via refresh token already provides convenience for the user.
- **Show the API key and recovery codes only once** — that's how the module works; don't store them in plain text on your side.
- **Don't disable `loginThrottle` / `ipLoginThrottle` in production.** Besides wrong passwords, they bound the `AUTH_MFA_REQUIRED` password oracle on MFA accounts (it is only returned for a correct password and is counted like a failure).
- **Keep the "always 200" responses** on the forgot/verify routes (already the default), so as not to reveal which emails have an account.
- **In a cluster (multiple machines)**, use shared stores (database/Redis) instead of the `Memory*` ones, or sessions and lockouts won't be shared across processes.
