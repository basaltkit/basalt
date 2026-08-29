# Security

Basalt is **secure by default** at the HTTP edge and fail-closed on secrets.
Everything here is zero-dependency and wired through the plugin lifecycle.

## The secure defaults, at a glance

Each of these ships ON by default — you have to opt *out*, never in. This
table is the map; each row's guide has the details and the opt-out.

| Default | What it prevents | Where |
|---|---|---|
| Boot refuses routes whose security meta has no enforcing guard (`UnguardedRouteMetaError`) | "protected" routes silently serving open | this page, below |
| Billing/invoice routes require an authenticated user (`meta.auth`) | anonymous card/plan management via a forged tenant | [Billing](/guide/billing) |
| Membership guard on every authenticated tenant request (`tenantMembershipPlugin`) | a valid user of tenant A driving tenant B (`TEAM_NOT_A_MEMBER`) | this page, below |
| Cache fails closed outside tenant context in multi-tenant apps (`MissingCacheScopeError`) | cross-tenant reads through a shared "global" namespace | [Caching](/guide/caching) |
| `meta.can` rejects unenforceable shapes (`PERMISSION_META_INVALID`) | a malformed declaration silently skipping authorization | [Authorization](/guide/authorization) |
| Signed storage URLs serve `Content-Disposition: attachment` | stored XSS via user uploads on a CDN origin | [Storage](/guide/storage) |
| Mail bodies build through `` html`…` `` with auto-escaped interpolations; log driver redacts bodies in production | markup injection in app mail · reset links in log aggregators | [Notifications](/guide/notifications) |
| Admin/UI pages carry a route-scoped, hash-locked CSP | inline-script injection — without weakening the app-wide CSP | [Admin pages](/guide/admin-pages) |
| Rate-limit keys ignore `X-Forwarded-For`; CORS never reflects arbitrary origins with credentials; HSTS/nosniff/frame-deny on | header-spoofed limits · credentialed cross-origin reads · clickjacking | this page, below |
| Secrets fail closed in production (`secret()`, `AUTH_WEAK_SECRET`) | booting with a guessable signing key | this page, below |

## Edge protection — `securityPlugin`

One plugin covers rate limiting, CORS and secure response headers. **Secure
response headers are on by default**; rate limiting and CORS are opt-in — enable
them explicitly for production. New apps ship `securityPlugin()` in the scaffold,
so headers are protected from the first deploy.

```ts
import { securityPlugin } from '@basaltkit/fastify'

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
used by `@basaltkit/cache`.

**Per-route limits.** A route can tighten the budget for a sensitive endpoint
via `meta.rateLimit` — it gets its own bucket (keyed by IP + route) at that
threshold, while every other route uses the global one:

```ts
route({
  method: 'POST',
  url: '/auth/login',
  meta: { rateLimit: { limit: 5, windowMs: 60_000 } }, // 5/min on top of the global limit
  // …
})
```

### CORS

`origin` accepts `true` (reflect), a string, an allow-list array, or a
predicate. Preflight `OPTIONS` requests are answered automatically.

::: warning Credentials require an explicit allow-list
Reflecting an arbitrary `Origin` back **with** `credentials: true` would hand
authenticated, cookie-bearing responses to any site. When `credentials` is on,
Basalt refuses to reflect — you **must** pass an explicit `origin` (string,
array, or predicate). A wildcard `*` is only ever emitted for non-credentialed
requests.
:::

### Secure headers

`headers: true` sets HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin` and a restrictive default
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (right for
a JSON API). Pass an object to customize (e.g. your own `contentSecurityPolicy`
for an HTML/docs surface), `contentSecurityPolicy: false` to omit just the CSP,
or `headers: false` to disable them all.

## Resource limits & DoS resistance

Beyond headers and rate limits, long-lived and slow connections can exhaust a
server. Basalt ships sane defaults and knobs for the sharp edges.

### Request timeouts (anti-slowloris)

A slow client that dribbles out a request one byte at a time ties up a connection
indefinitely. The Fastify adapter defaults to a **30 s `requestTimeout`** (Fastify's
own default is *disabled*); override it via `fastifyPlugin({ fastify: { requestTimeout } })`.
Express and Hono run on a Node server you own — set the same protection on it:

```ts
// Express / Hono (node:http server)
server.requestTimeout = 30_000   // whole request must arrive within 30s
server.headersTimeout = 20_000   // headers within 20s (slowloris headers)
server.keepAliveTimeout = 5_000
```

### SSE streams

Server-Sent Events are long-lived by design, so give them a heartbeat and a lifetime
cap. `send()` also returns a **backpressure** boolean — stop producing when it's `false`:

```ts
return sse(async (stream) => {
  for await (const update of source) {
    if (!stream.send({ data: update })) break // client can't keep up → back off
  }
}, { heartbeatMs: 15_000, maxDurationMs: 30 * 60_000 }) // ping every 15s, cap at 30 min
```

The heartbeat pings keep proxies from dropping an idle stream and reveal a dead socket;
`maxDurationMs` is a backstop against connections that never disconnect. Cap the number
of concurrent streams per user/tenant in your handler for a hard ceiling.

### Ceremony endpoints (WebAuthn, MFA)

Endpoints that mint a challenge or verify a code are pre-auth and cheap to hammer —
throttle them. Reuse the [brute-force lockout](#brute-force-lockout) and per-route
limits, and in production back the WebAuthn `PasskeyStore` / `WebAuthnChallengeStore`
(and MFA stores) with a **durable** implementation, not the in-memory default.

### Custom-domain re-verification

A verified custom domain that later expires or repoints its DNS is a takeover risk.
Re-verify on a schedule with [`@basaltkit/scheduler`](/guide/scheduler) — `verify(tenantId, domain, { force })`
re-checks the TXT record and **revokes** the domain if it no longer matches:

```ts
schedule.call('reverify-domains', async () => {
  for (const { tenantId, domain } of await listVerifiedDomains()) {
    await customDomains.verify(tenantId, domain, { force: true })
  }
}).daily().at('04:00')
```

## Fail-closed secrets — `secret()`

The most common production incident is shipping a placeholder signing key.
`secret()` makes that impossible:

```ts
import { defineEnv, secret } from '@basaltkit/env'

export const env = defineEnv({
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

- **Development**: uses `devDefault` when unset — the app just runs.
- **Production** (`NODE_ENV=production`): the variable is **required**, must
  meet a minimum length, and is **rejected if it looks like a placeholder**
  (`change-me`, `secret`, `password`, …). The app refuses to boot otherwise.

## Brute-force lockout

`@basaltkit/auth` throttles failed logins per email out of the box — no wiring
needed. After too many failures within a rolling window, `login()` throws
`AccountLockedError` (HTTP 429) even for the correct password; a success clears
the counter.

```ts
import { authPlugin, LoginThrottle } from '@basaltkit/auth'

authPlugin({
  users,
  secret: env.APP_SECRET,
  // defaults to 5 attempts / 15 min; customize or disable:
  loginThrottle: new LoginThrottle({ maxAttempts: 10, windowMs: 5 * 60_000 }),
  // loginThrottle: false, // to turn it off
})
```

A per-IP throttle runs alongside it (on by default) so a spray of one attempt
across many accounts is caught too — pass the client IP to `login({ ip })` (the
built-in route does this).

## Account enumeration is closed by default

The public register endpoint is **enumeration-safe**: registering an email that
already exists returns the *same* `202` (and does equivalent work) as a fresh
signup, so it can't be used to probe which emails have accounts. The collision is
signalled out-of-band via the `auth:register_existing_email` hook — email the
address "you already have an account; sign in or reset your password":

```ts
app.hooks.on('auth:register_existing_email', ({ email }) => sendAlreadyRegisteredEmail(email))

// opt out (classic 409 on duplicate) if you really need it:
authPlugin({ users, secret: env.APP_SECRET, enumerationSafeRegister: false })
```

Login, password-reset and email-verification responses are likewise uniform
whether or not the account exists (equalized timing, generic `{ ok: true }`), so
none of the auth endpoints leak which emails are registered.

## Idempotent mutations — `idempotencyPlugin`

Safe retries for `POST`: a client that sends an `Idempotency-Key` gets the
**same** response replayed on a retry, so a dropped connection never charges a
card twice.

```ts
import { idempotencyPlugin } from '@basaltkit/fastify'

idempotencyPlugin() // guards POST by default
```

- Repeat with the same key → the cached response, with `Idempotent-Replayed: true`.
- A repeat while the first is still in flight → `409 IDEMPOTENCY_CONFLICT`.
- `5xx` responses are **not** cached, so genuine failures stay retryable.
- Keys are scoped by **caller + method + route**: a per-caller fingerprint is
  mixed into the stored key, so one user's cached response can never be replayed
  to another (no cross-user/tenant leak), and the same key on two endpoints
  can't collide.

## Revoking access tokens

Access tokens (JWTs) are stateless, so they normally stay valid until they
expire. Wire a `TokenVersionStore` to revoke them early — a password reset (and
the explicit `revokeAllTokens(userId)`) then invalidates every token issued
before the bump:

```ts
import { authPlugin, MemoryTokenVersionStore } from '@basaltkit/auth'
import { PrismaTokenVersionStore } from '@basaltkit/auth-prisma' // or SqliteTokenVersionStore

authPlugin({ users, secret: env.APP_SECRET, tokenVersions: new PrismaTokenVersionStore(prisma) })
```

Off by default (verification then costs one store read per request). The signing
secret itself is guarded too: `Auth` refuses to start with an empty secret, and
in production rejects one shorter than 32 chars (a short HS256 key is
offline-forgeable) — use `secret({ minLength: 32 })`.

## Encrypting TOTP secrets at rest

TOTP is replay-protected out of the box (a code's time-step is recorded, so an
intercepted code is single-use). To also survive a database leak, encrypt the
stored secrets with an app-held key — they're kept as AES-256-GCM envelopes and
decrypted only when verifying a code:

```ts
authPlugin({ users, secret: env.APP_SECRET, mfaEncryptionKey: env.MFA_KEY })
```

Existing plaintext enrollments keep working and are encrypted on their next write.

## Shared responsibility — hardening your integration

Basalt closes the vulnerabilities it *can* close on its own. Three things,
though, depend on how **your app** wires the pieces together — the framework
can't decide them for you. Get these right in every deployment.

### 1. Authorization is explicit — declare a guard, don't just declare intent

A route's `meta.auth` / `meta.can` / `meta.teamRole` documents *what* the route
needs, but the **guard that enforces it must actually be registered**. A
declared-but-unguarded route would be **open** — so the adapters refuse to boot
it: at startup they verify that every declared security meta key has a
registered guard claiming it (via the `http:guarded-meta` bucket) and fail loud
listing every offending route.

```ts
// ❌ meta says "admin", but nothing enforces it → UnguardedRouteMetaError at BOOT
route({ method: 'POST', url: '/admin/purge', meta: { can: 'admin' }, handler })

// ✅ register the plugin whose guard enforces the key
authPlugin(…)         // enforces meta.auth
permissionsPlugin(…)  // enforces meta.can
teamsPlugin(…)        // enforces meta.teamRole
```

If protection genuinely happens at an outer edge/gateway, opt out explicitly
with the adapter option `allowUnguardedMeta: true` (or `['auth', …]` for
specific keys). A custom guard plugin that enforces one of these keys should
claim it: `ensureMetadata(container).add('http:guarded-meta', 'auth')`.

### 2. Never trust a client-supplied tenant — verify membership

Resolving the active tenant from a request header (or subdomain, or path) is
convenient, but the header is **attacker-controlled**. Reading
`X-Tenant-Id: acme` and scoping to `acme` without checking that the
*authenticated user actually belongs to `acme`* lets any logged-in user read
another tenant's data.

```ts
// ❌ tenant taken straight from a client header — cross-tenant access
const tenantId = req.headers['x-tenant-id']

// ✅ resolve, then confirm the user is a member before trusting it
const tenantId = req.headers['x-tenant-id']
if (!(await teams.can(tenantId, ctx().user.id, 'member'))) {
  throw new ForbiddenError()
}
```

Bind tenant selection to a **verified user↔tenant membership** (via
`@basaltkit/teams`, an API-key's `tenantId`, or a session claim) — never to the
raw request alone.

**Do this for every route at once with `tenantMembershipPlugin`.** Instead of
repeating the check, register the guard from `@basaltkit/teams`: on every
authenticated, tenant-scoped request it asserts the user is a member of the
resolved tenant and returns `403` otherwise. Central routes that legitimately
act outside one tenant (login, tenant creation, platform admin, invite accept)
opt out with `meta: { central: true }`.

```ts
import { teamsPlugin, tenantMembershipPlugin } from '@basaltkit/teams'

createApp({
  plugins: [
    authPlugin(/* … */),
    tenancyPlugin(/* … */),
    teamsPlugin(/* … */),
    tenantMembershipPlugin(), // secure by default: membership enforced everywhere
  ],
})

// a route the current user is not a member of → 403; central route opts out:
route({ method: 'POST', url: '/tenants', meta: { central: true }, /* … */ })
```

By default the guard checks membership **existence** — any membership record
passes, so custom roles absent from `roleRank` are not rejected; pass
`role: 'member'` (or higher) to enforce rank semantics. Two more options:

```ts
tenantMembershipPlugin({
  // WHO-based escape: platform admins / support cross tenants legitimately.
  // Prefer this over meta.central when the exemption is about the caller —
  // central disables the guard for everyone on that route.
  exempt: ({ user }) => (user as { platformAdmin?: boolean })?.platformAdmin === true,

  // Opt-in decision cache: without it, each authenticated tenant request costs
  // one indexed membership lookup (usually fine). Cached decisions are dropped
  // immediately by the team:joined/role_changed/member_removed hooks in the
  // same process; ttlMs only bounds staleness for changes made on ANOTHER
  // replica — a member removed elsewhere may retain access for up to ttlMs.
  cache: { ttlMs: 30_000 },
})
```

### 3. Automatic tenant scoping covers the ORM — not raw SQL or nested writes

The Prisma tenancy extension scopes standard model operations and **fails
closed** without a tenant context. Two paths sit *outside* that net:

- **Raw queries** — `$queryRaw` / `$executeRaw` bypass model scoping. Basalt now
  **refuses them by default when a tenant is in scope** (`PRISMA_RAW_IN_TENANT`),
  so a raw query can't silently read across tenants. Run them in central code
  (no tenant in context), or add the `tenant_id = $1` predicate yourself and set
  `onRawInTenant: 'allow'`.
- **Nested writes** — a `connect` / nested `create` reaching another model isn't
  re-scoped. Verify the related record belongs to the current tenant first.

```ts
// ❌ raw query inside a tenant context now throws PRISMA_RAW_IN_TENANT
await db.$queryRaw`SELECT * FROM invoices WHERE status = ${status}`

// ✅ scope explicitly, parameterized, and opt in
const tenantId = ctx().tenant.id
await db.$queryRaw`
  SELECT * FROM invoices WHERE status = ${status} AND tenant_id = ${tenantId}`
// with tenancyExtension({ onRawInTenant: 'allow' })
```

**Defense in depth — enable Postgres RLS.** Application-layer scoping is one
layer; add a database-enforced one so even a forgotten predicate can't leak.
`rlsPolicySql` generates the migration, and `set_config` names the active tenant
per transaction — the database then filters every row itself:

```ts
import { rlsPolicySql, setTenantConfigSql, tenantConfigParams } from '@basaltkit/prisma'

// migration (once): enable RLS + a tenant-isolation policy on each table
await db.$executeRawUnsafe(rlsPolicySql({ tables: ['invoices', 'projects'] }))

// per request: set the active tenant, transaction-local (never leaks on a pool)
await db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(ctx().tenant.id))
  // every query in here is filtered to the tenant by the database
})
```

When in doubt, prefer model operations (which are scoped automatically) over raw
SQL, and review every `connect` against the current tenant.

### 4. CSRF — safe by default with header auth; cookies are your responsibility

Basalt authenticates every request from a **header** — `Authorization: Bearer <jwt>` or `x-session-id: <id>` (see the auth enricher). This is **CSRF-safe by
design**: a cross-site request forgery works only with credentials the browser
attaches *automatically* (cookies, HTTP Basic). A custom header is never sent
cross-origin on a forged request, so an attacker's page can't ride the victim's
session. **Keep auth in a header and there is nothing to do.**

You take on CSRF the moment you move that credential into a **cookie** — e.g.
storing the session id or JWT in a cookie so the browser sends it automatically.
If you do, protect it yourself:

- Set the cookie `SameSite=Lax` (or `Strict`), `HttpOnly`, and `Secure`.
  `SameSite=Lax` alone stops the common cross-site `POST`.
- Add a second check for state-changing requests: a **double-submit CSRF token**
  (a random value mirrored in a cookie and a header/body field, compared on the
  server), or an **Origin/Referer allow-list**.
- Never rely on CORS for this — CORS governs *reading* a response, not whether a
  forged request is *sent*. A form `POST` fires regardless of CORS.

```ts
// ✅ preferred — no cookie, no CSRF surface
fetch('/api/pay', { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })

// ⚠️ if you must use a cookie session, add SameSite + a CSRF token check
setCookie('sid', session.id, { httpOnly: true, secure: true, sameSite: 'lax' })
```

## Catch regressions automatically — `ai:doctor`

`basalt ai:doctor` statically checks your project against the framework's
security invariants — offline, no API key. Two checks encode the most important
guarantees from the security guide:

- **`missing-tenant-membership`** (error) — you wire tenancy + auth + teams but no
  `tenantMembershipPlugin`, so a resolved tenant is never bound to a verified
  member. This is the cross-tenant-access class in section 2.
- **`missing-security-plugin`** (warning) — no `securityPlugin()`, so responses
  ship without secure headers.

```bash
basalt ai:doctor      # run it in CI to fail the build on a security regression
```

Wire it into your pipeline so a change that drops the membership guard or the
security plugin turns the build red instead of shipping.

## Supply chain

CI runs `pnpm audit` (high severity), **CodeQL** SAST, and **Dependabot** keeps
dependencies and Actions current. Releases publish to npm with **provenance**
(`NPM_CONFIG_PROVENANCE`) via changesets — no manual tokens or OTP in the
pipeline.
