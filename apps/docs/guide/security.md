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
them explicitly for production. New apps ship `securityPlugin()` in the scaffold
with a global per-IP rate limit enabled (`rateLimit: { limit: 120, windowMs: 60_000 }`),
so headers and request budgets are protected from the first deploy. With tenancy
and auth, the scaffold also registers `teamsPlugin()` + `tenantMembershipPlugin()`
(see *Never trust a client-supplied tenant* below).

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

The default store is in-memory (`MemoryRateLimitStore`). Its memory is bounded:
expired buckets are swept as traffic arrives, and at most `maxEntries` (default
100 000) buckets are kept — past that the oldest windows are evicted first, so a
flood of distinct client addresses cannot grow the process without limit
(`new MemoryRateLimitStore({ maxEntries })` to size it). A bucket that has used
up its limit is never evicted: a flood of new addresses cannot free a limited
client early — it is held until its window ends. For multiple instances
implement the `RateLimitStore` interface over Redis — the same driver pattern
used by `@basaltkit/cache`.

**Per-route limits.** A route can tighten the budget for a sensitive endpoint
via `meta.rateLimit` — it gets its own bucket (keyed by IP + route pattern) at
that threshold. It is enforced as a route guard, so it holds identically on
Fastify, Express and Hono, and also when the route is invoked as an MCP tool.
On Express and Hono (where the edge hook runs before routing) the request also
counts against the global bucket; on Fastify it is counted once, in its own
bucket:

```ts
route({
  method: 'POST',
  url: '/auth/login',
  meta: { rateLimit: { limit: 5, windowMs: 60_000 } }, // 5/min on top of the global limit
  // …
})
```

**Per-user and per-tenant budgets.** By default the bucket is the client IP, so
everyone behind one NAT or corporate proxy shares it. `meta.rateLimit.key` picks
who the bucket belongs to:

| `key` | Bucket | Use it for |
|---|---|---|
| `'ip'` (default) | client address (`request.ip`) | anonymous endpoints: login, sign-up, password reset |
| `'user'` | `ctx().user.id` | expensive per-user actions: exports, AI calls, uploads |
| `'tenant'` | `ctx().tenant.id` (shared by the tenant's users) | a per-organization quota |
| `'user+tenant'` | one bucket per user per tenant | a user who belongs to several tenants |
| `(ctx) => string` | whatever id you return (e.g. an API key id) | anything else |

```ts
route({
  method: 'POST',
  url: '/reports/export',
  meta: { auth: true, rateLimit: { limit: 10, windowMs: 60_000, key: 'user' } },
  // …
})
```

The key is resolved in the route guard, after the enrichers ran, so auth and
tenancy have already set `ctx().user` / `ctx().tenant`. When the id is missing
(an anonymous caller, no tenant resolved, or the function returns nothing), the
bucket **falls back to the client IP**, and anonymous buckets never mix with
signed-in ones. When the adapter could not resolve an IP either (`request.ip`
undefined — Hono on a runtime without `getClientIp`, a hand-built `runRoute`, an
MCP tool called over stdio or through `McpServer.callTool`), a signed-in caller
is keyed by identity (`user:<id>|tenant:<id>`, as `'user+tenant'` would), and
**every anonymous ip-less request shares one `unknown` bucket**: fail closed,
rather than a bucket per spoofable header. Configure the adapter to resolve the
client IP to get per-client buckets back. Keyed buckets use the same
store (`MemoryRateLimitStore`, or Redis across instances). A keyed route still
counts against the global per-IP limit on every adapter, because the pre-routing
hook cannot know the user yet.

### CORS

`origin` accepts `true` (reflect), a string, an allow-list array, or a
predicate. Preflight `OPTIONS` requests are answered automatically (`204`). They
count against the global rate limit like any other request, and the
`Access-Control-Allow-Methods` / `-Allow-Headers` / `-Max-Age` headers go only to
an allowed origin — a disallowed one gets a bare `204` that discloses nothing.

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
a JSON API), plus `Cache-Control: no-store` so no browser or intermediary cache
keeps a response carrying a session token, API key or MFA secret. Pass an object
to customize (e.g. your own `contentSecurityPolicy` for an HTML/docs surface, or
`cacheControl: 'private, no-cache'`), `contentSecurityPolicy: false` /
`cacheControl: false` to omit just that header, or `headers: false` to disable
them all. A route that is safe to cache sets its own `Cache-Control` header,
which replaces the default — do so on `meta.etag` routes (e.g.
`private, no-cache`), since `no-store` keeps browsers from revalidating.

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
Re-verify on a schedule with [`@basaltkit/scheduler`](/guide/scheduler) — `reverifyAll()`
re-checks the TXT record of every verified domain and **revokes** those whose
record is definitively gone (a DNS timeout leaves them verified):

```ts
schedule.call('reverify-domains', async () => {
  const { revoked } = await customDomains.reverifyAll()
  if (revoked.length) log.warn({ revoked }, 'custom domains un-verified')
}).daily().at('04:00')
```

A new owner of a lapsed domain can also take a stale verified claim over by
publishing its `challenge()` record — see [Tenancy](/guide/tenancy#custom-domains-verified).

## Fail-closed secrets — `secret()`

The most common production incident is shipping a placeholder signing key.
`secret()` makes that impossible:

```ts
import { defineEnv, secret } from '@basaltkit/env'

export const env = defineEnv({
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

- **Development** (`NODE_ENV=development` or `test`, set explicitly): uses
  `devDefault` when unset — the app just runs.
- **Everywhere else** — `NODE_ENV=production`, `staging`, **or unset**: the
  variable is **required**, must meet a minimum length, and is **rejected if it
  looks like a placeholder** (`change-me`, `secret`, `password`, …). The app
  refuses to boot otherwise, so forgetting `NODE_ENV` on a deploy can never
  fall back to the public dev default.

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
  This holds for every handler shape — one that returns its payload is replayed
  exactly like one that calls `reply.send()`.
- A repeat while the first is still in flight → `409 IDEMPOTENCY_CONFLICT`.
- `5xx` responses are **not** cached, so genuine failures stay retryable.
- Keys are scoped by **caller credentials + tenant + method + route**, hashed
  with SHA-256 before they reach the store. The credentials are every header in
  `credentialHeaders` (default `authorization`, `x-session-id`, `cookie`,
  `x-api-key`) and the tenant is `x-tenant-id` + `host`, so one user's cached
  response can never be replayed to another (no cross-user/tenant leak), and the
  same key on two endpoints can't collide. The replay runs before route guards:
  if you authenticate with another header, add it to `credentialHeaders`.
- Requests with **no** credential header are not cached or replayed by default
  (a stranger who guessed the key would otherwise get the response). Opt in with
  `allowAnonymous: true` only for public endpoints with nothing private in them.
- Keys longer than 255 characters → `400 IDEMPOTENCY_KEY_INVALID`;
  `MemoryIdempotencyStore` sweeps expired entries and is capped by `maxEntries`
  (default 10 000).

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
in production (anything but an explicit `NODE_ENV=development`/`test`, unset
included) rejects one shorter than 32 chars (a short HS256 key is
offline-forgeable) — use `secret({ minLength: 32 })`.

## Encrypting TOTP secrets at rest

TOTP is replay-protected out of the box (a code's time-step is recorded, so an
intercepted code is single-use). To also survive a database leak, encrypt the
stored secrets with an app-held key (at least 32 bytes) — they're kept as
AES-256-GCM envelopes (HKDF-derived key with a key id, bound to the user) and
decrypted only when verifying a code:

```ts
authPlugin({ users, secret: env.APP_SECRET, mfaEncryptionKey: env.MFA_KEY })
```

A stored value that is not such an envelope is refused, so a write to the table
cannot downgrade a secret to a plaintext one the writer knows. Key rotation and
migrating plaintext or `v1:` rows (an explicit `legacy` opt-in plus
`auth.reencryptMfaSecret(userId)`) are covered in
[Encrypting TOTP secrets at rest](/guide/auth#mfa-encryption).

## Secrets at rest {#secrets-at-rest}

Every secret Basalt stores encrypted — TOTP secrets (`@basaltkit/auth`'s
`SecretBox`, envelope `bka2`) and cloud-drive OAuth tokens
(`@basaltkit/drives`' `DriveSecretBox`, envelope `bkd1`) — goes through one
audited primitive, `createSecretBox` from `@basaltkit/core/secret-box`:

- **AES-256-GCM**, random 96-bit IV, full 128-bit tag (a shorter tag is refused);
- **HKDF-SHA256** key derivation under a per-box label, so the same key material
  used by two boxes yields unrelated keys;
- a **key ring with ids**: the first key seals, every key opens, and
  `reseal()` moves a row to the active key — rotation is rolling;
- **AAD binding** to the owning record (user, or tenant + connection +
  provider): a blob copied into another row fails the tag check;
- **no plaintext path**: anything that is not an envelope of that box is refused.

Use it for a secret of your own (webhook signing secrets, third-party API
tokens) instead of hand-rolling AES:

```ts
import { createSecretBox } from '@basaltkit/core/secret-box'

const box = createSecretBox({
  keys: [{ id: '2026-10', key: env.INTEGRATIONS_KEY }], // ≥ 32 bytes; new keys go first
  info: 'my-app:integration-tokens:v1',                 // unique per box
  version: 'mya1',                                      // envelope tag, [a-z0-9]{1,16}
  aadFields: 2,                                         // what each secret is bound to
})
const sealed = box.seal(token, [tenantId, integrationId])
const token2 = box.open(sealed, [tenantId, integrationId]) // throws SecretBoxError otherwise
```

Failures throw `SecretBoxError` with a `failure` of `config`, `malformed`,
`unknown-key`, `context` or `auth-failed` (never the secret or the key). The
subpath is not re-exported from `@basaltkit/core`'s main entry.

## Shared responsibility — hardening your integration

Basalt closes the vulnerabilities it *can* close on its own. Three things,
though, depend on how **your app** wires the pieces together — the framework
can't decide them for you. Get these right in every deployment.

### 1. Authorization is explicit — declare a guard, don't just declare intent

A route's `meta.auth` / `meta.can` / `meta.teamRole` / `meta.scopes` /
`meta.subscribed` / `meta.feature` documents *what* the route
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
apiKeysPlugin(…)      // enforces meta.scopes
subscriptionsPlugin(…) // enforces meta.subscribed and meta.feature
```

The full guarded set is `auth`, `can`, `teamRole`, `scopes`, `subscribed` and
`feature` (`GUARDED_META_KEYS`). Keys that *relax* rather than protect are
deliberately excluded — `meta.central` (skips the tenant-membership check),
`meta.mcp` (opts a route into MCP exposure) and `meta.rateLimit` (abuse
throttling, not an authorization boundary). A `meta.rateLimit` with no limiter
registered (no `securityPlugin({ rateLimit })`) does not refuse the boot, but
the adapter **warns once**, naming the routes, that those budgets are not
enforced. Silence it with `allowUnguardedMeta: ['rateLimit']` (or `true`) when
an outer edge throttles.

If protection genuinely happens at an outer edge/gateway, opt out explicitly
with the adapter option `allowUnguardedMeta: true` (or `['auth', …]` for
specific keys). A custom guard plugin that enforces one of these keys should
claim it: `ensureMetadata(container).add('http:guarded-meta', 'auth')`.

Claiming a key proves *someone* enforces it; it says nothing about the
**value**. For that, a plugin registers a route-meta validator in
`http:meta-validators` (`META_VALIDATORS_BUCKET`): every adapter runs them over
its full route list at boot, right after the guarded-meta check, and refuses to
start with `InvalidRouteMetaError` (`HTTP_INVALID_ROUTE_META`) listing every
`route: problem`. `teamsPlugin` uses it so `meta.teamRole: 'Admin'` (a typo)
fails the boot instead of answering 500 on the first request.
`allowUnguardedMeta` never waives validators.

```ts
const validator: RouteMetaValidator = ({ route, container }) =>
  typeof route.meta?.['shape'] === 'string' || route.meta?.['shape'] === undefined
    ? undefined
    : `meta.shape must be a string` // or string[] for several problems; throwing counts too
ensureMetadata(container).add(META_VALIDATORS_BUCKET, validator)
```

Driving `runRoute()` without an adapter? `assertRoutesGuarded(routes,
app.container)` runs both checks; `assertRouteMetaValid(routes, app.container)`
runs the validators alone.

A guard may also publish a **pure visibility check** in `http:route-visibility`
(`RouteVisibilityCheck`, evaluated by `isRouteVisible`) — "could this caller
possibly pass?" with no side effects (no rate limit, no audit, no hooks), used
by listing surfaces such as MCP's `tools/list`. Visibility is never
authorization: the guard still runs on every call.

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

### 3. Automatic tenant scoping covers the ORM — not raw SQL or foreign-key scalars

The Prisma tenancy extension scopes model operations (nested relation writes
included) and **fails closed**: without a tenant context, and for any
operation it cannot scope (`PRISMA_UNSCOPED_OPERATION`). Update data cannot
move a row to another tenant (`PRISMA_CROSS_TENANT_WRITE`). Two paths sit
*outside* that net:

- **Raw queries** — `$queryRaw`, `$executeRaw`, `$queryRawTyped`,
  `$runCommandRaw` (every client-level operation) and MongoDB `findRaw` /
  `aggregateRaw` bypass model scoping. Basalt **refuses them by default when a
  tenant is in scope** (`PRISMA_RAW_IN_TENANT`), so a raw query can't silently
  read across tenants. Run them in central code (no tenant in context), or add
  the `tenant_id = $1` predicate yourself and set `onRawInTenant: 'allow'`.
- **Foreign-key scalars** — nested `connect` / `create` are scoped, but a raw
  FK value (`data: { projectId: body.projectId }`) is not checked, and an
  `include` follows whatever FK is stored. Use composite foreign keys
  `(tenantId, id)` (the database then refuses a cross-tenant link) and RLS, or
  verify the related record belongs to the current tenant first.

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
layer; add a database-enforced one so even a forgotten predicate can't leak —
including the foreign-key `include` above, which the extension cannot see.
`rlsPolicySql` generates the migration, and `tenancyExtension({ rls: true })`
names the active tenant to Postgres on every tenant-scoped operation:

```ts
import { rlsPolicySql, tenancyExtension, tenantTransaction } from '@basaltkit/prisma'

// migration (once): put the generated SQL in a Prisma migration — it enables
// and FORCEs RLS and adds a tenant-isolation policy on each table
console.log(rlsPolicySql({ tables: ['invoices', 'projects'], tenantColumn: 'tenantId' }))

// every model operation in tenant scope now runs as
//   $transaction([ set_config('app.tenant_id', <tenant>, true), <operation> ])
const db = new PrismaClient().$extends(tenancyExtension({ rls: true }))

// interactive transactions: open them with tenantTransaction, which sets the
// tenant on the transaction's own connection first — tx stays tenant-scoped
await tenantTransaction(db, async (tx) => {
  const invoice = await tx.invoice.create({ data })
  await tx.invoiceLine.createMany({ data: lines(invoice.id) })
})
```

- **Connect as a role RLS applies to.** Superusers and `BYPASSRLS` roles skip
  every policy; table owners skip them unless the table has `FORCE ROW LEVEL
  SECURITY` (`rlsPolicySql` adds it by default). Run the app as a plain login
  role and keep migrations/admin work on a separate one.
- **No tenant means no rows — even on a reused connection.** The policy
  compares against `NULLIF(current_setting('app.tenant_id', true), '')`: once a
  pooled session has set the tenant in any transaction, Postgres returns `''`
  (not `NULL`) for it afterwards, and a bare comparison would match rows whose
  tenant column is `''`. Policies generated before `@basaltkit/prisma` 3.0 lack
  the `NULLIF` — re-run `rlsPolicySql` (idempotent) in a new migration.
- **Costs.** Each tenant-scoped operation becomes a short batch transaction
  (`BEGIN`, `set_config`, the query, `COMMIT`) — a few extra statements on the
  same connection (≈ +2 ms p50 in the app team's measurements). The setting is
  transaction-local (`set_config(…, true)`), so it never leaks onto a pooled
  connection.
- **Transactions you open yourself are not wrapped** (they can't be nested):
  a plain interactive `db.$transaction(async (tx) => …)` runs without the
  tenant setting and fails closed (reads see no rows, writes fail with
  `42501`) — use `tenantTransaction(db, fn)` instead. A batch
  `db.$transaction([...])` must **lead** with the setting:
  `db.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(tenantId))`.
  That exact statement, for the tenant already in scope, is the one raw query
  the `PRISMA_RAW_IN_TENANT` guard lets through — every other raw query is
  still refused.
- A client with `onMissingTenant: 'bypass'` sends no setting, so under RLS it
  sees nothing: give central/admin code its own database role (`BYPASSRLS`, or
  one the policies don't cover).

**Full-text search under RLS — the GIN index silently disappears.** RLS on a
table that also has a `tsvector` column with a GIN index (what
`@basaltkit/search-postgres` creates) is a trap nothing warns about: PostgreSQL
may only evaluate a qualifier *before* a row-security policy if that qualifier
is `LEAKPROOF`, and the text-search operator `@@` is not. So for the very role
the policy protects you with, `tsv @@ plainto_tsquery(…)` can never be an index
condition — it becomes a filter applied after the policy, and the plan degrades
to a sequential scan over every tenant's rows. Measured on 30 200 documents
(PostgreSQL 16):

```text
-- as the owner                        -- as the application role, same SQL
->  Bitmap Heap Scan                    ->  Seq Scan on basalt_search
      Recheck Cond: (tsv @@ …)                Filter: (… AND (tsv @@ …))
      ->  Bitmap Index Scan on                Rows Removed by Filter: 30197
            basalt_search_tsv_idx       Execution Time: 14.702 ms
Execution Time: 4.920 ms                                (~24x slower, warm)
```

`rlsSearchFunctionSql` generates the fix: a `SECURITY DEFINER` search function
that re-applies the tenant predicate itself, so `@@` is an index condition again
while the rows it can ever return are still exactly one tenant's.

```ts
import { rlsSearchFunctionSql } from '@basaltkit/prisma'

// migration (once), run as a role that bypasses the table's RLS
rlsSearchFunctionSql({
  name: 'basalt_search_scoped', table: 'basalt_search', vectorColumn: 'tsv',
  partitionColumn: 'idx', filterColumn: 'document',
  columns: [{ name: 'document', type: 'jsonb' }],
  role: 'app', owner: 'app_owner', maxRows: 100,
})

// runtime — the driver routes text queries through the function
new PostgresSearchDriver({ client: pool, searchFunction: 'basalt_search_scoped' })
```

```text
-- as the application role, through the function
->  Bitmap Heap Scan on basalt_search t
      Filter: ((idx = 'notes') AND (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')))
      ->  Bitmap Index Scan on basalt_search_tsv_idx
Execution Time: 1.850 ms
```

The function takes **no tenant parameter**: it reads the tenant from the same
`current_setting(…)` the policy reads (the one `tenancyExtension({ rls: true })`
already sets), so there is nothing for a caller to point elsewhere, and an unset
setting reads as `NULL` — no rows, never all rows. It is hardened like the
cross-tenant scan (pinned `search_path`, validated identifiers, `EXECUTE`
revoked from `PUBLIC`, `p_limit` clamped), and the driver additionally refuses
any returned row whose tenant is not the one it asked for.

**Never `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF`.** It is the
shortcut every search result suggests, and it does bring the index back — by
weakening the leakproof rule **database-wide**, for every table and every policy
in the database, so a crafted `@@` becomes a side channel for probing rows a
policy hides. A local speed-up bought with a global loss of isolation.

**Sweeping every tenant — the one hole, made narrow.** A reconciler has to find
stuck rows *across all tenants*, which under RLS the application role can never
see. `crossTenantScanSql` generates the only safe shape of that query: a
`SECURITY DEFINER` function that returns **identifiers only** (tenant id + row
id), owned by a role the policies don't reach, with `search_path` pinned inside
it and `EXECUTE` revoked from `PUBLIC`. `crossTenantSweep` then processes every
identifier back inside its own tenant's scope, where the policies apply again:

```ts
import { crossTenantScanSql, crossTenantSweep } from '@basaltkit/prisma'

// migration (once): identifiers only — never a column holding tenant data
crossTenantScanSql({
  name: 'stuck_jobs', table: 'jobs', tenantColumn: 'tenantId', columns: ['id'],
  where: `t."status" = 'PROCESSING' AND t."updatedAt" < now() - interval '15 minutes'`,
  role: 'app', owner: 'app_owner', maxRows: 500,
})

// reconciler (central code, no tenant in scope)
await crossTenantSweep({
  client: db,
  scanFunction: 'stuck_jobs',
  run: (tenantId, fn) => tenancy.run(tenantId, fn),
  handle: (item) => RetryJob.dispatch({ jobId: item.id }),
})
```

The function is a **deliberate RLS bypass**, so treat its definition as
security-critical: widen it to one data column and every caller with `EXECUTE`
reads every tenant. Basalt fails closed around it — the scan refuses to run
inside a tenant context (`PRISMA_CROSS_TENANT_IN_TENANT`; unlike the internal
`set_config`, it gets no exemption from the raw guard), refuses a deployed
function that returns columns you did not declare
(`PRISMA_CROSS_TENANT_SCAN_SHAPE`), and pages with a capped, ordered cursor so a
sweep can't pull the whole table. Without RLS the function isn't needed at all:
pass an ordinary central query as `scan`. See
[the scheduler guide](/guide/scheduler#sweeping-every-tenant).

When in doubt, prefer model operations (which are scoped automatically) over raw
SQL, and review every `connect` against the current tenant.

### 4. CSRF — safe by default with header auth; cookies are your responsibility

Basalt authenticates every request from a **header** — `Authorization: Bearer <jwt>` or `x-session-id: <id>` (see the auth enricher). This is **CSRF-safe by
design**: a cross-site request forgery works only with credentials the browser
attaches *automatically* (cookies, HTTP Basic). A custom header is never sent
cross-origin on a forged request, so an attacker's page can't ride the victim's
session. **Keep auth in a header and there is nothing to do.**

The session cookie `authRoutes()` sets on login (`basalt_session`) is covered by
`authPlugin`'s built-in check: a cookie-only request with an unsafe method that
the browser marks `cross-site`/`same-site`, or whose `Origin` is not your own host
or a `csrf.trustedOrigins` entry, is not authenticated (`403 AUTH_CSRF_REJECTED`
on `meta.auth` routes) — see [Cookie sessions and CSRF](/guide/auth#cookie-sessions-and-csrf).

You take on CSRF yourself the moment you move a credential into a cookie of your
**own** — e.g. storing a JWT in a cookie so the browser sends it automatically.
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

## Route security review — `basalt routes`

`basalt routes` lists every route with the guards it **declares**: `auth`, `can`,
`rateLimit`, `tenant` and the other guarded keys (`mfa`, `teamRole`, `scopes`,
`subscribed`, `feature`). Two ways to turn that into a gate:

```bash
# CI: exit 1 when a route does not declare both auth and can (explicit opt-outs pass)
pnpm basalt routes --unguarded --require=auth,can --allow='POST /webhooks/*'
pnpm basalt routes --json > routes.json   # the whole table, for review or diffing
```

```ts
// A vitest that boots the app (no listen) and asserts on the same rows
import { ensureMetadata } from '@basaltkit/core'
import { describeRoutes, findUnguardedRoutes } from '@basaltkit/http'

it('every route declares auth + can', async () => {
  const app = await buildApp().boot()
  const rows = describeRoutes(ensureMetadata(app.container).get('http:routes'))
  expect(findUnguardedRoutes(rows, { require: ['auth', 'can'] })).toEqual([])
  await app.shutdown()
})
```

`auth: false` (or `public: true`) is an intentional opt-out and satisfies both
requirements; `can: false` satisfies `can`. Only `auth: true` counts as `auth` — it is the
one value `authPlugin` enforces. **This checks route meta only**: an
app-wide rate limit, URL-based tenancy (`tenancyPlugin({ required: { except } })`),
app hooks or middleware, and the edge routes plugins mount themselves (`healthPlugin`,
`metricsPlugin`, `openapiPlugin`) are invisible to it — a clean run means "every
route asks for protection", while the boot check above guarantees a guard is there
to enforce it.

## Catch regressions automatically — `ai:doctor`

`basalt ai:doctor` statically checks your project against the framework's
security invariants — offline, no API key. Two checks encode the most important
guarantees from the security guide:

- **`missing-tenant-membership`** (error) — you wire tenancy + auth but no
  `tenantMembershipPlugin` (whether or not `@basaltkit/teams` is installed — if
  it is not, the fix is to install it), so a resolved tenant is never bound to a
  verified member. This is the cross-tenant-access class in section 2.
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
