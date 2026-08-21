# Security

Basalt is **secure by default** at the HTTP edge and fail-closed on secrets.
Everything here is zero-dependency and wired through the plugin lifecycle.

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
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and
`Cross-Origin-Opener-Policy: same-origin`. Pass an object to customize (e.g. a
`contentSecurityPolicy` for HTML surfaces) or `false` to disable.

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

## Shared responsibility — hardening your integration

Basalt closes the vulnerabilities it *can* close on its own. Three things,
though, depend on how **your app** wires the pieces together — the framework
can't decide them for you. Get these right in every deployment.

### 1. Authorization is explicit — declare a guard, don't just declare intent

A route's `meta.can` (or `meta.teamRole`) documents *what* the route needs, but
the **guard that enforces it must actually be registered**. A declared-but-
unguarded route is **open**: there is no implicit default-deny that blocks a
request just because a permission was named.

```ts
// ❌ meta says "admin", but nothing enforces it → the route is public
route({ method: 'POST', url: '/admin/purge', meta: { can: 'admin' }, handler })

// ✅ register the guard that reads meta and rejects unauthorized callers
app.use(authorizationPlugin())        // enforces meta.can on every route
app.use(teamsPlugin())                // enforces meta.teamRole
```

Treat "a route with a permission in `meta` but no matching guard in the
pipeline" as a bug. A good pattern is a CI check that fails when any route
declares `meta.can`/`meta.teamRole` while the enforcing plugin is absent.

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

## Supply chain

CI runs `pnpm audit` (high severity), **CodeQL** SAST, and **Dependabot** keeps
dependencies and Actions current. Releases publish to npm with **provenance**
(`NPM_CONFIG_PROVENANCE`) via changesets — no manual tokens or OTP in the
pipeline.
