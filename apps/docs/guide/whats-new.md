# What's new in Basalt 1.12

> *"Basalt 1.12" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

::: warning Thirty-two packages publish a major — six of them twice
`auth` 4, `auth-prisma` 2, `auth-sqlite` 2, `auth-saml` 3, `permissions` 4
(`permissions-prisma` / `-sqlite` 2), `tenancy` 3, `tenancy-prisma` 2,
`storage` 5, `files` 6, `comments` 4, `search` 2, `search-elasticsearch` 2,
`audit` 3 (`audit-prisma` / `-sqlite` 2), `webhooks` 4 (`webhooks-prisma` /
`-sqlite` 2), `subscriptions` 5 (`subscriptions-prisma` / `-sqlite` 3),
`teams` 4, `queue` 3, `prisma` 3, `mcp` 5, `express` 2 and `hono` 2 — and the
three drive adapters reach 1.0. Some packages went through two majors in this
wave: `permissions`, `storage`, `files`, `audit`, `webhooks` and `mcp` first
shipped the audit's fixes (as 3, 4, 5, 2, 3 and 4) and then, a day later, the
follow-ups in [Closing the harvest](#closing-the-harvest). Coming from 1.11,
you take both sets of steps. Three 0.x packages break in a minor: `drives` 0.3,
`mcp-core` 0.4 and `ai-mcp` 0.3 (by way of 0.2). Most of these are one option or
one renamed call; four need a data step (a re-key, a re-encryption, two new
auth models, regenerated RLS policies). See [Upgrading](#upgrading).
:::

Basalt 1.12 is the release that **keeps its word**. Every package makes
promises — in its README, in its types, in the name of an option — and 1.11 had
made sure the secure behaviour was the default. What nobody had checked
systematically was whether the default did what the promise said. So an
independent audit, in two passes, read each package's source next to its
documentation and turned every mismatch it found into a failing test against
the published build.

It found eighty. Ten were rated high, and none of them looked like a security
bug from the outside — each was a sentence the framework said about itself. The
README promised `audit.verify()` would detect a forged row, and a row inserted
straight into the table passed. `idempotencyPlugin` was documented for `route()`
handlers, and a handler that *returned* its payload — the shape every example
uses — ran again on every retry. A policy for `project:constructor` resolved
through `Object.prototype` and authorized anyone. `meta.teamRole: 'Admin'`, a
typo for `'admin'`, ranked zero and admitted every member. `swap()` moved a free
subscription onto a paid plan without charging it. `@basaltkit/env` said an
unset `NODE_ENV` was production and `@basaltkit/auth` said it was development.

All eighty are closed. Each real defect was reproduced with a failing test
before it was fixed, and that test now lives in the package's own suite; a
hypothesis that did not reproduce is documented, not "fixed". The
theme is the gap between declared and actual behaviour, and it runs through
every item below: a single-tenant key that could not be a tenant's name, a
resolver that could not be overruled by a header, three adapters that send the
same bytes for the same route, an MCP endpoint that knows which session it is
talking to.

The report also ended with a harvest: design gaps and improvements beyond its
eighty numbered findings. Two more pull requests closed that list after the
release and ship inside the same wave — policies that run in the route guard,
error details that are public by construction, audit hashes that name their
key, webhooks that respect a port policy and a fan-out cap, and more. See
[Closing the harvest](#closing-the-harvest).

## Highlights

### Promises the code now keeps
- **The audit trail detects what the README said it detects.** `verify()` now
  also reads a tenant's rows outside its chain: a row written after the chain
  began without a place in it fails with `unchained-entry` and is listed in
  `unverified`; `verify({ expectedHead })` anchors the head so a deleted tail is
  `truncated`, not silent. Payloads are deep-frozen, the redactor matches secret
  keys on their words (`privateKey`, `client_secret`, `dsn`…) and pseudonymises
  international phone numbers as documented, and store filters are validated —
  `?tenantId[not]=x` can no longer reach a Prisma `where`. *(`@basaltkit/audit`
  2.0, `audit-prisma` / `audit-sqlite` 2.0)*
- **`idempotencyPlugin` replays handlers that return a value.** Only handlers
  that called `reply.send()` themselves were covered; every other route ran on
  every retry of the same `Idempotency-Key` and reported a spurious 500.
  *(`@basaltkit/fastify` 2.5)*
- **A permission check answers only the question it was asked.** Policy lookups
  no longer walk the prototype, a check authorizes only when it returns exactly
  `true`, only an exact `resource:action` selects a policy check, a missing user
  id is a 401 rather than a shared bucket, and a permission with an empty segment
  (`'projects:'`) matches nothing. With tenancy active, a write with no tenant
  and no scope throws `PERMISSION_SCOPE_REQUIRED` instead of quietly granting
  platform-wide. *(`@basaltkit/permissions` 3.0)*
- **A typo'd role fails the boot.** An unknown `meta.teamRole` used to rank zero
  and admit everyone; now it makes every adapter refuse to start with
  `InvalidRouteMetaError`, naming the route. An unranked role is matched exactly,
  and "one pending invitation per e-mail" is case-insensitive. *(`@basaltkit/teams`
  4.0)*
- **One `NODE_ENV` rule everywhere.** `isProductionEnvironment()` is the single
  fail-closed policy: only an explicit `development` or `test` is not
  production. `auth` applies its 32-character secret floor and `Secure` cookies
  under it, `mailer` stops logging mail bodies, and `queue` warns about an
  implicit sync driver. *(`@basaltkit/core` 1.5, `auth` 4.0, `mailer` 2.1,
  `queue` 3.0)*
- **The single-tenant key cannot be a tenant.** `SINGLE_TENANT_SCOPE` was
  `'default'` — a valid tenant id, so a request naming the tenant `default`
  reached a single-tenant app's records. It is `'@single'` in files, comments,
  search and drives, and a tenant equal to it is refused. *(`@basaltkit/files`
  5.0, `comments` 4.0, `search` 2.0, `drives` 0.3)*
- **Storage keys name one object on every driver.** A tenant segment must be
  canonical (`Acme` and `acme` shared a directory on a case-insensitive disk),
  every scoped disk fails closed without a tenant (a hand-built `new Disk()`
  used to fall back to the bucket root), keys with `.` or empty segments are
  refused, and a copy from a tenant disk cannot land in another tenant's tree.
  *(`@basaltkit/storage` 4.0)*
- **Webhook deliveries keep their identity.** Outbox deliveries carry a stable
  id across retries, permanent failures stop being re-dispatched to healthy
  endpoints (`onPermanentFailure`), each retry is signed with its own timestamp,
  and `register()` validates the endpoint — URL, scheme, a secret of at least 16
  characters, events — instead of storing one that fails on every delivery.
  *(`@basaltkit/webhooks` 3.0)*

### Who is asking, and on whose behalf
- **The Host decides the tenant, not a header.** `subdomainResolver`,
  `domainResolver` and `routeResolver` are authoritative: they run before any
  fallback, and a name that does not exist resolves to no tenant instead of
  deferring to `x-tenant-id`. The tenant-id grammar applies to resolution and
  `run()`, `normalizeDomain()` validates instead of URL-parsing
  (`acme.basalt.app@evil.com` became `evil.com`), unverified domain claims
  expire, and `CustomDomains.reverify()` lets a lapsed domain change hands.
  *(`@basaltkit/tenancy` 3.0)*
- **A social login is bound to the provider's subject.** Account links
  (provider + subject → user) replace matching by e-mail alone; a second account
  at the same IdP claiming a linked e-mail gets `409 AUTH_ACCOUNT_LINK_CONFLICT`.
  OIDC providers can be restricted to their e-mail domains — required once more
  than one provider is configured — and `id_token` `aud`, `exp` and `iss` are
  checked. *(`@basaltkit/auth` 4.0)*
- **Passkeys and TOTP secrets hold under concurrency and tampering.** The
  WebAuthn counter is written by compare-and-set, so a cloned authenticator
  racing the genuine one loses; `remove()` checks the owner; the challenge is
  bound to the user. TOTP secrets are sealed with AES-256-GCM under an
  HKDF key ring with the user id as associated data, and a value that is not an
  envelope is refused rather than read as plaintext. *(`@basaltkit/auth` 4.0,
  `auth-prisma` / `auth-sqlite` 2.0)*
- **SAML responses belong to the browser that asked, signed with SHA-2.**
  `samlRoutes()` bind each login to an HttpOnly cookie (login CSRF), node-saml
  errors are a 400, and SHA-1 signatures and digests are refused by default.
  *(`@basaltkit/auth-saml` 3.0)*
- **A job runs as its dispatcher, and nothing else.** The worker rebuilds the
  context from an allowlist — request ids, a validated tenant, `userId` restored
  as `user: { id }` so audit entries name an actor — instead of spreading
  whatever the broker held. Envelopes can be HMAC-signed (`signingKey`), and a
  second definition under a taken job name throws. The Redis realtime backplane
  can be signed too, and `subscribe()` re-checks the connection after its async
  gate. *(`@basaltkit/queue` 3.0, `queue-bullmq` 1.1, `queue-rabbitmq` 1.4,
  `queue-sqs` 1.3, `realtime` 1.5)*

### Money, indexes and rows
- **Billing charges before it grants.** `swap()` onto a paid plan from a
  subscription with no gateway behind it throws `402 BILLING_PAYMENT_REQUIRED`;
  usage amounts must be positive integers in every store; a webhook for a
  replaced gateway subscription no longer cancels the active one; Lemon Squeezy
  renewals are no longer dropped as duplicates; Paddle and Lemon Squeezy
  signatures are read from their own headers, and both go through `checkout()`.
  Coupons, invoices and the payment ledger validate their inputs.
  *(`@basaltkit/subscriptions` 5.0, `subscriptions-prisma` / `-sqlite` 3.0)*
- **A rebuild clears only what it can refill.** `reindex()` never files a
  tenant-less row under the calling tenant, validates every row before it
  clears anything, and inside a tenant rebuilds only that tenant — a
  whole-index rebuild says `{ all: true }`. Paging and filters are bounded and
  validated. Elasticsearch documents with URL-special characters in their id are
  addressed by one `_id` again. *(`@basaltkit/search` 2.0, `search-elasticsearch`
  2.0, `search-postgres` 1.2)*
- **The tenant pool never disconnects a client in use.** `TenantClientPool`
  evicts only idle clients and, when every client is busy, waits and then answers
  `503 PRISMA_POOL_EXHAUSTED` — the cap is never exceeded. RLS policies compare
  against `NULLIF(current_setting(…), '')`, a switched tenant without a client
  fails closed, and class DTOs are scoped like plain objects. *(`@basaltkit/prisma`
  3.0)*
- **MySQL stops truncating silently.** Every `*-prisma` package ships a
  `schema.mysql.prisma` with the free-text columns widened, `basalt prisma:sync`
  copies it for a MySQL datasource, and an opt-in `columnLimits: 'mysql'` refuses
  an over-long value with `COLUMN_LENGTH_EXCEEDED` instead of writing a cut hash.
  Tenancy saves are atomic, and webhook endpoints are keyed by tenant.
  *(`@basaltkit/prisma` 3.0, `tenancy-prisma` 2.0, `webhooks-prisma` 2.0, and the
  other `*-prisma` stores)*

### Three adapters, one wire
- **The same route sends the same bytes on Fastify, Express and Hono.** A string
  is `text/plain` on all three (Express served it as `text/html` — a reflected
  XSS on that adapter only); JSON is `application/json` or `+json` by exact
  media type; a malformed body is a 400; a repeated query key is an array; the
  body limit is 1 MiB; `sse()` keeps the CORS and security headers set before
  it; after-hooks run for abandoned responses. A shared parity suite holds it.
  *(`@basaltkit/http` 2.6, `fastify` 2.5, `express` 2.0, `hono` 2.0)*
- **Route meta is validated at boot.** Plugins register validators for the
  values their meta keys carry (`http:meta-validators`), and side-effect-free
  visibility checks (`http:route-visibility`) let a listing hide what a caller
  could never pass. `expose = false` keeps an upstream reply out of a 502.
  *(`@basaltkit/http` 2.6)*

### MCP over a network
- **`/mcp` knows its caller and its session.** A foreign `Origin` gets 403, a
  body that is not JSON gets 415, a tool call receives an allowlist of headers
  instead of all of them, and a 4xx from the handler is an `isError` result.
  `initialize` issues an `Mcp-Session-Id` bound to the caller, so a cancellation
  in a later POST reaches the call it names and no other; `tools/list` hides what
  the caller could not use. *(`@basaltkit/mcp` 4.0)*
- **The MCP core refuses to be reachable by accident.** `serveHttp` will not
  bind off loopback without `authorize`, caps request bodies, never answers a
  notification, supports JSON-RPC batches and real stdio elicitation — so
  `basalt_make` in `ai-mcp` refuses an `apply` it cannot confirm instead of
  writing silently. *(`@basaltkit/mcp-core` 0.4, `ai-mcp` 0.2)*
- **External drives stay inside their root.** Listing cursors are signed to
  their tenant and connection (a Graph cursor is a URL fetched with the
  connection's token), a `rootId` confines every call, and the three adapters
  reach 1.0. *(`@basaltkit/drives` 0.3, `drives-dropbox` / `drives-google` /
  `drives-microsoft` 1.0)*

### Closing the harvest
The audit's report did not stop at its eighty findings: it closed with a
harvest of design gaps and improvements. Two pull requests landed after the
release and finished that list, so they ship inside 1.12 — and six packages
publish their second major of the wave.
- **Policies run in the route guard.** A plain `meta.can` was RBAC only: the
  guard never passed a resource, so a policy registered with `definePolicy`
  never decided a route. `meta.can` now also takes `{ permission, resource,
  notFound? }`, alone or in an all-of array: the guard loads the resource with
  the route's parsed input, calls `gate.authorize(user, permission, resource)`,
  answers 404 `RESOURCE_NOT_FOUND` for a missing one (or an audited 403 with
  `notFound: 'deny'`), and the handler reads it back with `canResource()`. A
  requirement no registered policy decides refuses the boot.
  *(`@basaltkit/permissions` 4.0)*
- **`hasRole()` answers membership, and `/me/access` shows every door that
  opens.** A super admin no longer "holds" every role name ever typed — the
  bypass is authority, not membership, and `gate.isSuperAdmin()` asks for it
  explicitly. `GET /me/access` now comes from `gate.describeAccess()`: global
  grants, temporary grants, delegations and the super-admin bypass, each with its
  source. Temporary grants and delegations get durable stores, so they survive a
  restart and are seen by every instance. *(`@basaltkit/permissions` 4.0,
  `permissions-prisma` / `-sqlite` 2.1)*
- **Error details are public by construction.** `new HttpError(…, {
  internalDetails })` is a log-only channel the error reporter receives and no
  response or tool result ever carries. `@basaltkit/mcp` passes a thrown error's
  `details` through `redactSensitiveDetails` before they reach the model, and
  tool-call errors, which used to vanish, are reported. *(`@basaltkit/http` 2.7,
  `mcp` 5.0)*
- **Audit hashes name their algorithm and their key.** New entries are
  `v2:sha256:…` or `v2:hmac-sha256:<keyId>:…`, so the HMAC key can be rotated
  (`keyId`, `verifyKeys`) without failing every entry the old key signed; v1
  entries keep verifying. `verify()` also catches a duplicate `seq` at a page
  boundary. *(`@basaltkit/audit` 3.0, `audit-prisma` / `-sqlite` 2.0.1)*
- **Webhooks respect a port policy and a fan-out cap.** Deliveries go to `80`,
  `443` or an unprivileged port outside `DEFAULT_BLOCKED_PORTS` — no longer to
  an exposed Redis or Postgres. DNS resolution runs inside the per-attempt
  deadline, a dispatch to more than 100 endpoints per event and scope is
  refused, at most 16 deliveries run at once, and `rotateSecret()` signs with
  both secrets for a grace window. *(`@basaltkit/webhooks` 4.0,
  `webhooks-prisma` / `-sqlite` 2.1)*
- **Storage hands back the keys it takes, and holds lengths to their word.**
  `list()` on a tenant disk returns `a/1.txt`, not `tenants/<id>/a/1.txt`, which
  `get()` then prefixed a second time; the prefix is a directory on every
  driver. A `contentLength` is validated and counted, and a body that
  contradicts it is never committed. S3 streams an unknown-length upload by
  multipart instead of buffering it. *(`@basaltkit/storage` 5.0, `storage-s3`
  1.4)*
- **File routes answer a public projection.** `GET /files` and friends returned
  the raw record — storage path, checksum, `uploadedBy`, the scanner's output.
  They now send `toPublicFile(record)`, and `fileRoutes({ present })` chooses
  another shape. *(`@basaltkit/files` 6.0)*
- **A suspended tenant is a 403, and an unknown status fails closed.** Every
  status other than `ready` used to be a 503 "still being provisioned" —
  including `suspended`, so clients retried a locked-out account.
  *(`@basaltkit/tenancy` 3.1)*
- **The MFA step is no longer a password oracle.** `AUTH_MFA_REQUIRED` is only
  returned for a correct password, so it now counts against the login throttles
  like a wrong one. *(`@basaltkit/auth` 4.1)*
- **The AI bridge enforces "dev-only".** `ai-mcp` refuses to start under
  `NODE_ENV=production` without an explicit override, and a tool's
  `workspaceRoot` must resolve inside the project root. *(`@basaltkit/ai-mcp`
  0.3)*

### Docs
- Every guide the fixes touched was updated, in English and Portuguese: [wire
  behaviour on the three adapters](/guide/adapters#wire-behaviour-—-identical-on-all-three),
  [MCP sessions and cancellation](/guide/mcp#sessions-and-cancellation) and
  [what `tools/list` shows](/guide/mcp#what-tools-list-shows), [the trust
  boundary in a queue worker](/guide/queues#context-in-the-worker-—-and-the-trust-boundary),
  [permission writes that need a tenant](/guide/authorization#writes-need-a-tenant-or-an-explicit-scope),
  [MySQL persistence](/guide/persistence#mysql), [rebuilding a search
  index](/guide/search#rebuilding-an-index), [encrypting TOTP secrets at
  rest](/guide/auth#mfa-encryption) and [upgrading drives from
  0.2.x](/guide/drives#upgrading-from-0-2-x).
- The harvest added [policies in the
  guard](/guide/authorization#policies-in-the-guard-resource-requirements),
  [`GET /me/access`](/guide/authorization#what-may-i-do-—-get-me-access),
  [what the model sees when a tool
  fails](/guide/mcp#what-the-model-sees-when-a-tool-fails), and the webhook
  [port policy](/guide/webhooks#port-policy), [fan-out cap](/guide/webhooks#fan-out-cap)
  and [secret rotation](/guide/webhooks#rotating-a-signing-secret);
  `CONTRIBUTING.md` gained a testing checklist.

## Upgrading

Packages are independent — bump only what you use. Each changeset carries its
full migration notes in the package's `CHANGELOG.md`; below are the changes most
likely to reach an application.

### Defaults that now refuse

| Package | What refuses | Opt-out / fix |
| --- | --- | --- |
| `auth` 4 | an unset `NODE_ENV` with a secret under 32 characters (`AUTH_WEAK_SECRET`); session cookies are `Secure`; several OAuth providers where an OIDC one declares no e-mail domains; a second IdP account claiming a linked e-mail (`409`); two different API keys on one request (`400`) | `NODE_ENV=development` locally, `sessionCookie: { secure: false }`; `allowedEmailDomains` or `allowAnyEmailDomain: true`; `oauthPlugin({ subjectConflict: 'link' })`; send one key |
| `mailer` 2.1 | mail bodies in the log with `NODE_ENV` unset | `NODE_ENV=development` or `logBody: true` |
| `tenancy` 3 | a header overriding a Host resolver; an unknown subdomain falling through to the header; ids outside the grammar in resolution and `run()`; non-hostnames in `normalizeDomain()` | `authoritative(fn)` for a trusted custom resolver; widen `validateTenantId`; IDNs in `xn--` form |
| `permissions` 3 | scope-less writes outside a tenant when tenancy is active; permissions with an empty segment; three-segment permissions against a policy; `grantTemporarily()` without a deadline | pass `GLOBAL_SCOPE` explicitly or `allowGlobalWrites: true`; `ttlMs` / `expiresAt` |
| `storage` 4 | a hand-built `Disk` or custom scope with no tenant; non-canonical tenant ids in the default scope; keys like `a//b`, `./a`, a trailing `/`; a scoped → central copy into `tenants/` | `scope: null` or `onMissingScope: 'root'`; a custom `scope` that maps ids; build keys with `parts.join('/')` |
| `files` 5 | HTML, SVG, XML or executables uploaded as `application/octet-stream` | declare the type and let `allowedTypes` judge it |
| `webhooks` 3 | `register()` with a bad URL, a secret under 16 characters or no events (`WEBHOOK_ENDPOINT_INVALID`); an id held by another tenant (`409`) | validate input first; hook `onPermanentFailure` to alert on failures the outbox no longer retries |
| `mcp` 4 | a foreign `Origin` (`403`); a non-JSON body (`415`); a later POST without its `Mcp-Session-Id` (`400` / `404`) | `mcpRoutes({ allowedOrigins })`; `mcpRoutes({ sessions: false })`; add `Mcp-Session-Id` to CORS `exposeHeaders` for browser clients |
| `mcp-core` 0.4 / `ai-mcp` 0.2 | `serveHttp` off loopback without `authorize`; bodies over 1 MiB; an `apply` that cannot be confirmed | `authorize` / `allowRequest`, `maxBodyBytes`; `--token`; `--allow-unconfirmed-apply` |
| `auth-saml` 3 | SHA-1 signatures and digests; a response not bound to the browser that started the login; a configured `emailAttribute` that is missing | `allowSha1: true` per provider; `bindToBrowser: false`; fix the attribute name |
| `teams` 4 | an unknown `meta.teamRole` or `tenantMembershipPlugin({ role })` — the app does not boot | fix the role, or rank it in `roleRank` |
| `queue` 3 | two different jobs under one name; `attempts: 0`; job context with a tenant outside the grammar | rename, or `queuedOn(…, { name })`; `attempts` ≥ 1; pass the same `validateTenantId` to the queue plugin |
| `subscriptions` 5 | `swap()` onto a paid plan with no gateway subscription (`402`); `subscribe()` to a paid plan on Paddle or Lemon Squeezy (`501`); non-positive-integer usage | `swap(id, plan, { allowUnpaid: true })`; `checkout()` |
| `search` 2 | a bare `reindex()` outside a tenant when tenancy is registered; `limit` over 1000, `offset` over 10000; filters on undeclared fields or with `null` values | `reindex(name, { all: true })`; `searchPlugin({ maxLimit, maxOffset })`; declare the field `filterable` |
| `prisma` 3 | a new tenant while every pooled client is in use — `503` after `acquireTimeoutMs` | size `max` for concurrently active tenants; keep `idleMs` above the longest request, or `pool.use(tenantId, fn)` |
| `audit` 2 | `verify()` / `verifyAll()` fail for rows outside the chain written after it began | `legacyUntil` for a known, benign source such as a rolling deploy |

### Data steps

**The `'@single'` sentinel.** A single-tenant app with persisted records re-keys
them once, or they read as missing. Skip it if `default` was ever a real tenant
in that database — those rows belong to it.

```sql
UPDATE files         SET "tenantId" = '@single' WHERE "tenantId" = 'default';
UPDATE file_versions SET "tenantId" = '@single' WHERE "tenantId" = 'default'; -- with files-versions
UPDATE comments      SET "tenantId" = '@single' WHERE "tenantId" = 'default'; -- comments-prisma
UPDATE comments      SET tenant_id  = '@single' WHERE tenant_id  = 'default'; -- comments-sqlite
```

The search index is derived data: rebuild it (`search.reindex(name)`), or with
`search-postgres` re-key in place. Drive connections cannot be re-keyed with SQL
— each secret is sealed with its tenant as associated data — so re-seal them with
`DriveSecretBox` as the `@basaltkit/drives` changelog shows, then move the import
ledger.

**MFA secrets.** Keys must be at least 32 bytes, and rows sealed before 1.12 are
refused. Upgrade with a temporary opt-in, re-encrypt, then remove it:

```ts
authPlugin({
  mfaEncryption: {
    keys: [{ id: '2026-09', key: NEW_KEY_32_BYTES }],
    legacy: { v1Keys: [OLD_MFA_ENCRYPTION_KEY], plaintext: true },
  },
})
for (const userId of usersWithMfa) await auth.reencryptMfaSecret(userId)
// then drop `legacy`
```

**Two new auth models.** `@basaltkit/auth-prisma` adds `AuthAccountLink` and
`AuthPasskey` — `basalt prisma:sync`, then a migration (in every tenant schema
with schema-per-tenant; MySQL apps take them from `schema.mysql.prisma`). Then
run `normalizeAuthUserEmails(prisma, { dryRun: true })`, again without `dryRun`,
and merge any reported `conflicts` — until then those e-mails throw
`AUTH_EMAIL_AMBIGUOUS`. `@basaltkit/auth-sqlite` creates the tables in
`migrate()`. Configure a durable `accountLinks` store: existing users are linked
on their next login by verified e-mail.

**RLS policies.** `rlsPolicySql` and `rlsSearchFunctionSql` now compare against
`NULLIF(current_setting(…, true), '')`. Re-run the generated SQL — both are
idempotent — in a new migration.

**Smaller ones.** Paddle and Lemon Squeezy subscriptions created through
`subscribe()` carry a checkout id as `gatewayRef`: clear it or set the real
`sub_…` id. Elasticsearch documents indexed one at a time with URL-special
characters in their tenant or id need one `reindex(name, { all: true })`. Stored
grants with an empty permission segment never granted anything and can be
deleted.

### Express and Hono change what a client receives

On **Express**: return HTML with an explicit `content-type`; send JSON with a
JSON media type; an empty JSON body is now `undefined`, so default it in the
schema (`z.object({…}).default({})`); routing is case-sensitive and strict and
the query parser is `simple` — pass your own `app` if you relied on the old
behaviour. On **Hono**: read a repeated query key as `string | string[]`;
`request.url` is the path and query string, so build an absolute URL with
`new URL(request.url, base)`; a malformed JSON body is a 400 before the handler;
pass `errorHandler: false` if you install your own `onError`.

### Custom stores, drivers and gateways implement more

A custom `PasskeyStore` must implement `compareAndSetCounter` (the service
refuses to start without it). A custom `BillingGateway` implements
`resumeSubscription` or `resume()` throws, and `CouponStore.incrementRedemptions`
takes a `limit` and may return `null`. Optional, but worth it:
`SearchDriver.clearTenant` (tenant-scoped rebuilds), `AuditStore.auditTenants`,
`DomainStore.replace` / `listVerified`, and `replayKey` from a custom drive
adapter. Hand-written Prisma clients and test fakes need `$transaction`
(`tenancy-prisma`) and `create` / `updateMany` (`webhooks-prisma`,
`auth-prisma`); a generated `PrismaClient` already has them.

### MySQL column limits are opt-in

Nothing changes on PostgreSQL or SQLite, or on MySQL until you ask. To adopt it,
let `basalt prisma:sync` copy the `schema.mysql.prisma` variants, migrate, and
pass `columnLimits: 'mysql'` to the store factories. The
[MySQL guide](/guide/persistence#mysql) has the details.

### What the harvest changes

These are the steps for the versions in [Closing the
harvest](#closing-the-harvest). Coming from 1.11, apply them on top of
everything above: the rows for `permissions` 3, `storage` 4, `files` 5,
`audit` 2, `webhooks` 3 and `mcp` 4 still hold for the next major. None of these
needs a data migration unless you opt into a new store or column.

**`permissions` 4 — `hasRole()` is membership.** `gate.hasRole(user, role)` no
longer returns `true` for every role to a super admin; `can()`, `authorize()`
and `meta.can` still honour the bypass. Where `hasRole()` was an authorization
check, check the permission instead, or ask for the bypass explicitly:

```ts
if ((await gate.isSuperAdmin(user)) || (await gate.hasRole(user, 'billing-manager'))) { … }
```

`GET /me/access` keeps `roles` and `permissions` — clients now see more, correct,
entries: global roles and grants, live temporary grants and delegations, `'*'`
for a super admin — and adds `superAdmin` and `grants` (each permission with its
`source`). The durable temporary-grant and delegation stores are opt-in: with
`permissions-prisma`, wiring them means adding `PermTemporaryGrant` and
`PermDelegation` (`basalt prisma:sync`) and migrating; `permissions-sqlite`
creates the tables in `migrate()`.

**`audit` 3 — v2 hashes.** New entries use the v2 format; existing v1 entries
keep verifying and new entries chain onto them, so there is nothing to migrate.
But:

- **Do not roll back** to an earlier `@basaltkit/audit` after writing v2
  entries — it cannot verify them.
- Code that assumed a 64-hex `hash` (a column, a regex, `--expected-head`) must
  allow up to 144 characters; the bundled stores and the MySQL preset fit it.
- Tooling that recomputes hashes: `computeAuditHash()` still computes v1 — use
  `computeAuditHashV2()` or `checkAuditHash(entry, keysById)`.
- An exhaustive `switch` over `AuditVerifyFailure` needs an `'unknown-key'` case.
- To rotate the key: `integrity: { mode: 'hash-chain', key: NEW, keyId:
  '2026-09', verifyKeys: [OLD] }`.

**`webhooks` 4 — ports, fan-out and concurrency.** An endpoint on a blocked port
is refused at `register()` and at delivery: allow it with `ssrf: { allowedPorts:
[…] }` (or `'any'`). A dispatch to more than 100 matching endpoints in one scope
is refused — raise `maxEndpointsPerDispatch`. At most 16 deliveries run at once
(`dispatchConcurrency`). To use `rotateSecret()`, Prisma users add
`previousSecret` / `previousSecretExpiresAt` (`basalt prisma:sync`) and migrate
first; `webhooks-sqlite` adds the columns in `migrate()`; a custom store must
persist both fields and clear them when `add()` receives them as `undefined`.
`@basaltkit/drives` gets the same port policy on every hop.

**`storage` 5 — relative keys and exact lengths.** `Disk.list()` returns keys
relative to the disk's scope: drop code that stripped `tenants/<id>/` by hand,
and list a real directory instead of relying on a partial-name prefix match on a
cloud driver. A `contentLength` that is not a non-negative safe integer is a
`400 STORAGE_CONTENT_LENGTH_INVALID`; a body that does not match it is a
`400 STORAGE_CONTENT_LENGTH_MISMATCH` and stores nothing. Custom drivers need no
change.

**`files` 6 — the routes' shape.** `GET /files`, `GET /files/:id` and
`POST /files` send `toPublicFile(record)`: no `path`, `checksum`, `tenantId`,
`uploadedBy` or scan detail. A client that read one of them needs a `present`:

```ts
fileRoutes({ present: (file) => ({ ...toPublicFile(file), uploadedBy: file.uploadedBy }) })
```

`files.get()` / `list()` and the `file:*` hooks still return the full record.
`upload({ contentLength })` is now verified (`413 FILE_TOO_LARGE` up front,
`400` on a mismatch) — never pass a multipart request's own `Content-Length`.

**`mcp` 5 — redacted details, reported errors.** A value under a secret-named key
in a thrown error's `details` reaches the model as `'[REDACTED]'`: move
operator-only data to `internalDetails`, or pass `redactErrorDetails: false` (or
your own redactor). Tool-call errors now reach `reportError` — the console by
default; `reportError: false` restores the silence.

**`tenancy` 3.1 — status codes.** A `suspended` tenant answers a non-retryable
`403 TENANT_SUSPENDED` instead of `503`; a status tenancy does not know (such as
`active`) is `500 TENANT_STATUS_UNKNOWN`. Store `ready`, or no status, for a
serving tenant.

**`auth` 4.1 — MFA and the throttle.** A code-less first step on an MFA account
now spends a login-throttle slot, like a wrong password; size `ipLoginThrottle`
for large shared-NAT populations.

**`ai-mcp` 0.3 — dev-only, enforced.** It refuses `NODE_ENV=production`
(`--allow-production`, `allowProduction: true` or
`BASALT_AI_MCP_ALLOW_PRODUCTION=1` to override), and `basalt_analyze`,
`basalt_doctor` and `basalt_plan` refuse a `workspaceRoot` outside the project
root.

---

## Previously — Basalt 1.11

> *The release that **fails closed**: composition bugs from a second security
> audit, fourteen majors that make secure behaviour the default, streaming on every
> adapter, a verifiable audit trail, and two new packages — backup and drives.*

::: warning Fourteen packages publish a major
This wave changes secure defaults. `auth` 3, `auth-saml` 2, `env` 3,
`permissions` 2, `prisma` 2, `tenancy` 2, `storage` 3, `files` 4, `comments` 3,
`audit-viewer` 3, `webhooks` 2, `subscriptions` 4, `teams` 3 and `mcp` 3 each
break something that used to work *because* it used to work without being asked.
The rule for every one of them: a working app breaks without a code, config or
data change. See [Upgrading to 1.11](#upgrading-to-1-11) — most edits are one option, two need a
data migration.
:::

Basalt 1.11 is the release that **fails closed**. Two things happened in the
same month. A second deep security audit — fourteen auditors, eighty-seven
distinct findings, one critical — went through the framework looking not for
bugs in packages but for bugs *between* them: an API key that was valid in
every tenant because keys and tenancy had never been introduced; a Prisma
operation the tenant extension did not know about and therefore did not scope;
a webhook endpoint signed with the plugin-wide secret because nobody had said
which tenant it belonged to. And two applications kept building on the
framework — a document-management SaaS and a logistics SaaS — and kept a list
of every place the framework made them write what it should have written:
streaming, structured errors, a verifiable audit trail, roles for every tenant,
a way to find stuck work under row-level security.

Seventy-seven of the findings are fixed with regression tests, and twenty-eight
items from the applications' list are closed. The theme they share is the
default. Where 1.10 supplied a missing half, 1.11 changes what happens when a
half is missing: a disk with no tenant refuses instead of writing to the bucket
root; a raw query inside a tenant refuses instead of seeing everything; an
unset `NODE_ENV` counts as production instead of development. Nothing in this
list is a new capability. Every one of them is a capability that used to be
opt-in becoming the thing you have to opt *out* of.

### Composition bugs the audit found
- **API keys are bound to their tenant.** A key issued inside a tenant is
  refused on any request that resolves a different tenant, or none
  (`403 AUTH_APIKEY_TENANT_MISMATCH`); a key issued without a tenant is refused
  on tenant requests unless `allowTenantlessKeys`. This was the one critical
  finding: keys and tenancy each worked, and together a key was valid
  everywhere. Scopes are now an upper bound too — a key without `*` cannot act
  as its owner on routes that declare no `meta.scopes`, and `meta.apiKey: false`
  makes a route session-only. *(`@basaltkit/auth` 3.0)*
- **The Prisma tenant extension refuses what it cannot scope.** Client-level
  raw operations, MongoDB raw reads and `updateManyAndReturn` inside a tenant
  are refused (`PRISMA_RAW_IN_TENANT`, `PRISMA_UNSCOPED_OPERATION`); nested
  relation writes are narrowed to the tenant and update data that changes the
  tenant field throws `PRISMA_CROSS_TENANT_WRITE`. `tenantSchema()` is
  injective, so two ids can no longer share a schema. *(`@basaltkit/prisma` 2.0)*
- **Storage, cache and realtime fail closed without a tenant.** A disk on the
  default scope with tenancy active refuses a tenant-less write
  (`STORAGE_TENANT_REQUIRED`) instead of falling back to the bucket root; central
  disks say `scope: null`. Temporary URLs are capped at seven days. A tenant id
  with `:` in it cannot address another tenant's cache keys or channels, because
  the id is now validated (`/^[a-z0-9][a-z0-9_-]{0,62}$/`, `global` reserved)
  before anything is written. *(`@basaltkit/tenancy` 2.0, `storage` 3.0, `cache`
  2.0.1, `realtime` 1.4.1)*
- **The global permission scope cannot be a tenant.** `GLOBAL_SCOPE` is
  `'@global'`, a value no tenant id can take; the Gate refuses to evaluate a
  tenant whose id is a reserved scope. Rows written under the old `'global'`
  need a one-line migration. *(`@basaltkit/permissions` 2.0)*
- **Tenant webhooks get their own secret.** A tenant endpoint is never signed
  with the plugin-wide secret and deliveries are never sent unsigned by default;
  a dispatch with no tenant reaches only tenant-agnostic endpoints. The SSRF
  guard classifies IPv6 by its parsed bytes, so mapped and translated private
  addresses are refused too. *(`@basaltkit/webhooks` 2.0)*
- **Object-level authorization on files, comments and the audit viewer.**
  `fileRoutes()` is owner-only unless told otherwise; `auditViewerRoutes()`
  refuses to boot without a guard; an explicit `tenantId` argument inside a
  tenant context must match it. *(`@basaltkit/files` 4.0, `comments` 3.0,
  `audit-viewer` 3.0, `search` 1.6)*
- **Invitations, billing, SSO and MCP close their own doors.** Accepting a team
  invitation needs a verified e-mail and one token enrols one account; a billing
  driver with an empty webhook secret throws instead of accepting an empty HMAC,
  and checkout redirects are restricted to known origins; each SAML provider is
  restricted to the e-mail domains it may assert; a spawned MCP server inherits
  an allow-list of environment variables, not `APP_SECRET`. *(`@basaltkit/teams`
  3.0, `subscriptions` 4.0, `auth-saml` 2.0, `mcp` 3.0)*
- **An unset `NODE_ENV` is production.** `secret()` applies `devDefault` only
  when `NODE_ENV` is explicitly `development` or `test`, so a deploy that forgets
  the variable can no longer boot on the public dev secret. New apps also get
  `teamsPlugin()` + `tenantMembershipPlugin()` by default, and `make:resource`
  generates authenticated, tenant-owned code with a test that proves it.
  *(`@basaltkit/env` 3.0, `create-basalt` 1.5, `generator` 1.4)*

### What two applications made the framework write
- **Streaming, in both directions, on every adapter.** `disk.putStream` /
  `getStream` / `copy` / `stat` on S3, Azure and GCS, with `maxBytes` enforced
  while the bytes arrive; S3 multipart for streams of unknown length as an
  optional capability; `route({ body: upload({ maxBytes, maxFiles, allowedTypes }) })`
  for multipart on Fastify, Express and Hono alike; and a handler that returns
  `stream(source, { contentType, filename })` — backpressure is real, a client
  that disconnects destroys the source, and `GET /files/:id/content` uses it.
  *(`@basaltkit/storage` 3.2, `storage-s3` 1.3, `http` 2.2 & 2.4, `files` 4.1–4.3)*
- **`rawBody()` — the octets that were actually sent.** Every webhook provider
  signs the bytes it sent, and every adapter parsed JSON before a handler could
  see them; `JSON.stringify` of the parsed object is not those bytes. Apps
  verifying Stripe, Paddle or Lemon Squeezy signatures may have been failing
  every genuine delivery. A `rawBody()` route leaves the body unread until after
  guards ran, and refuses (`RAW_BODY_UNAVAILABLE`) rather than reconstructs.
  *(`@basaltkit/http` 2.5, `fastify` 2.4, `express` 1.9, `hono` 1.9,
  `subscriptions` 4.0.1)*
- **Errors carry data.** `new HttpError(status, code, message, { details })`
  and `BasaltError` expose `error.details`, bounded and sanitised by the
  serializer, so a UI stops parsing "Checks failed: A, B" out of a message.
  `BasaltClientError.errorDetails` reads it back. *(`@basaltkit/core` 1.4,
  `http` 2.3, `sdk` 2.1)*
- **A verifiable audit trail.** `integrity: 'hash-chain'` gives every entry a
  sequence and a hash over its predecessor; `audit.verify()` detects edited,
  deleted, reordered and forged rows; `requestContext: true` records IP and
  user-agent through the redactor. *(`@basaltkit/audit` 1.6, `audit-prisma` /
  `audit-sqlite` 1.2)*
- **MFA by policy, throttles across replicas.** `authPlugin({ requireMfa })`
  refuses credentials obtained without a second factor; tokens carry `amr`;
  a `ThrottleStore` (memory or Redis) backs login and e-mail throttles across
  instances; logout ends a cookie session with an empty body; auth routes carry
  `meta.account`, which the membership guard honours. *(`@basaltkit/auth` 3.1,
  `teams` 3.0.1)*
- **Row-level security, applied and swept.** `tenancyExtension({ rls: true })`
  sets the tenant on the connection before every operation so Postgres policies
  filter too; `prismaPlugin({ assertMigrated })` refuses to boot against the
  wrong database; `crossTenantScan` / `crossTenantSweep` give a reconciler an
  audited way to find stuck work in every tenant and handle each row inside its
  own tenant's context; and the GIN index survives full-text search under RLS.
  *(`@basaltkit/prisma` 2.1–2.3, `search-postgres` 1.1, `scheduler` 1.5,
  `events` 1.3)*
- **Roles for every tenant, once.** `roleCatalog` on the Gate is a code-defined
  role → permissions map valid in every scope, so a catalogue no longer has to be
  copied into each tenant; `teams.members()` and the user source can now name
  everyone with a role without reaching into the auth tables.
  *(`@basaltkit/permissions` 2.1, `auth` 3.2, `teams` 3.1)*
- **Pre-signed direct uploads**, with Content-Type, length and SHA-256 bound
  into the signature on S3 (and the honest subset on Azure and GCS), plus the
  `s3Disk` fix that had been dropping every disk option except `scope`.
  *(`@basaltkit/storage` 3.1)*
- **Files know what they are.** `validate.sniff` reads the real type from the
  magic bytes; `requireScan` quarantines a file until a scanner clears it
  (`423 FILE_NOT_SCANNED`). *(`@basaltkit/files` 4.1)*
- **App-specific env prefixes.** `defineEnv(shape, { prefix: 'MY_SAAS' })` reads
  `MY_SAAS_DATABASE_URL` first, so `node --env-file` can no longer boot one app
  against another project's exported database. Scaffolds wire it.
  *(`@basaltkit/env` 3.1, `create-basalt` 1.7)*
- **Generated code that compiles.** `make:service` alone no longer imports a
  repository it never created; every `make:<kind>` names the siblings it still
  needs. `create-basalt` asks the registry for the latest version of every
  dependency, and `--prisma` scaffolds a PostgreSQL-backed app.
  *(`@basaltkit/generator` 1.5, `create-basalt` 1.5–1.8)*

### Two packages debut
- **`@basaltkit/backup`** — PostgreSQL backups as a service: custom-format
  dumps streamed to any Basalt disk, manifests with checksums, retention,
  restore with integrity verification, per-tenant schema and database targets,
  scheduler and CLI integration. Passwords reach `pg_dump` through the
  environment, never the command line. *(0.3.0)*
- **`@basaltkit/drives`** — connect a tenant's external file storage and keep
  it in sync: OAuth connect flow, listing, change feeds with cursor reset,
  streamed download and upload, signed notifications with a neutral endpoint
  parity-tested on all three adapters. Three adapters ship with it:
  **`drives-dropbox`**, **`drives-google`** and **`drives-microsoft`**
  (OneDrive / SharePoint). The phase-2 audit of the adapters found one
  credential leak and one silent data-loss bug before anyone else could.
  *(0.2.0 / 0.1.0)*

### Docs
- **[The multi-tenant pattern](/guide/multi-tenant-pattern)** — the canonical way
  to build a schema-per-tenant SaaS on Basalt, written as ten checkable rules
  after auditing three production apps, with the privilege chains each of them
  actually shipped. The shared-database tip, the tenancy troubleshooting advice
  and the cookbook were corrected where they contradicted it.
- Guides for [backups](/guide/backup) and [external drives](/guide/drives).

### Upgrading to 1.11

Packages are independent — bump only what you use. Every major below has an
explicit opt-out named next to it; prefer fixing the app.

#### Defaults that now refuse

| Package | What refuses | Opt-out / fix |
| --- | --- | --- |
| `auth` 3 | API keys outside their tenant; narrow keys on unscoped routes; cross-site cookie-only writes (`AUTH_CSRF_REJECTED`); social login on unverified e-mail; OAuth without browser binding | `apiKeysPlugin({ allowTenantlessKeys, allowNarrowKeysOnUnscopedRoutes })`, `authPlugin({ csrf: { trustedOrigins } })`, `socialLogin({ mfa: 'skip' })`, use `OAuth.authorize()` |
| `env` 3 | `devDefault` when `NODE_ENV` is unset | set `NODE_ENV=development` where you meant it |
| `tenancy` 2 | ids outside the grammar; `tenantScoped()` with no tenant in context | rename ids; `requireTenantId(id)` / `tenancy.run(id, …)` in system code |
| `prisma` 2 | raw ops and cross-tenant writes inside a tenant; non-canonical schema names | `setTenantConfigSql` is the one allowed raw statement; rename schemas once (README) |
| `storage` 3 | tenant-less access on a tenant-scoped disk; temporary URLs over 7 days | `scope: null` on central disks; `maxTemporaryUrlTtl` |
| `permissions` 2 | evaluating a tenant named like a scope | migrate `'global'` rows (below) |
| `files` 4 / `comments` 3 / `audit-viewer` 3 | non-owner file access; unguarded audit viewer; a `tenantId` that differs from the context | `fileRoutes({ authorize, shared })`, `auditViewerRoutes({ meta: { can } })` |
| `webhooks` 2 | unsigned or shared-secret tenant deliveries; tenant-less register/list | `allowUnsigned`, `allowSharedSecret`, `{ system: true }` |
| `subscriptions` 4 | empty `webhookSecret`; redirect URLs off the configured origins | set the secret; `allowedRedirectOrigins` |
| `teams` 3 | invite acceptance without verified e-mail; granting roles above your rank | `teamRoutes({ requireVerifiedEmail: false })`, `grantableRoles` |
| `auth-saml` 2 | assertions for other domains; IdP-initiated responses; node-saml < 5.1 | `allowedEmailDomains`, `validateInResponseTo: 'ifPresent'` |
| `mcp` 3 | full `process.env` to spawned servers | `env` allow-list on the client |

#### Two data migrations

**Permissions.** Grants written under the pre-2.0 global scope are no longer
read. Rename them once:

```sql
UPDATE perm_user_roles       SET scope = '@global' WHERE scope = 'global';
UPDATE perm_user_permissions SET scope = '@global' WHERE scope = 'global';
UPDATE perm_role_permissions SET scope = '@global' WHERE scope = 'global';
```

`readLegacyGlobalScope: true` on the Gate keeps reading the old rows while the
migration is scheduled — a transition aid, not a setting to keep.

**Prisma schema names.** `tenantSchema()` now suffixes any id that is not
canonical (`acme`, `acme_co` keep their names; `Acme Co` becomes
`tenant_acme_co__<hash>`). Tenants with non-canonical ids have a schema under
the old name and must be renamed once — the `@basaltkit/prisma` README has the
statement. Canonical ids are unaffected.

#### Columns that are added, never required

`@basaltkit/audit-prisma` 1.2 adds nullable `ip`, `userAgent`, `chain`, `seq`,
`prevHash`, `hash` and a unique `(chain, seq)`; they are written only when
`integrity` or `requestContext` is on. `@basaltkit/events-prisma` 1.2 adds
`lockedUntil` / `lockedBy` for multi-replica outbox claiming (`claim: true`).
Run `basalt prisma:sync` and a migration; the SQLite stores add the columns
themselves.

#### `GLOBAL_SCOPE` is a constant, not a string

If any code spells `'global'` — a seed script, a CLI command, a test — it now
grants into a scope nobody reads. Import `GLOBAL_SCOPE` from
`@basaltkit/permissions`. The [multi-tenant pattern](/guide/multi-tenant-pattern#rule-7-—-one-permissions-system-scoped-by-plane)
has the shape.

#### `sharp` and `nodemailer`

`@basaltkit/image-sharp` 1.1.4 requires a patched `sharp` (libheif
vulnerabilities); `@basaltkit/mailer-smtp` 1.0.1 accepts nodemailer 9 and 10.

---

## Previously — Basalt 1.10

> *The release of **missing halves**: a tenant that can be destroyed, an index that
> can be rebuilt, a durable store for files, revisions for documents, and
> permissions that know who is asking.*

::: warning Two contracts changed
`@basaltkit/files` revises its store contract, and `app.server` in
`@basaltkit/testing` is now awaited. Both edits are mechanical — see
[Upgrading to 1.10](#upgrading-to-1-10). Prisma apps that use API keys also need one new column.
:::

Basalt 1.10 is the release of **missing halves**. The application that wrote 1.9
kept going, and what it ran into this time was not two packages that failed to
fit together — it was capabilities with no other side. A tenant could be created
and never destroyed. An index could be kept current and never rebuilt. A
permission said what a caller may do and never who they are.

A missing half does not announce itself. There is no stack trace for a question
the framework has no answer to: every application invents its own, the inventions
differ, and the one that is wrong looks exactly like the one that is right — until
somebody sees a record that was not theirs.

### Capabilities that only worked in one direction
- **A tenant can be removed.** `TenantSource` had `find`, `findByDomain`, `list`,
  `create` and `save`; `Tenancy` had no `destroy` — no path out, not even an
  optional one. In tests that meant `DROP SCHEMA` with a string-interpolated
  identifier, and the reason it was needed is worse than the pattern: without the
  cleanup, a leftover schema makes the next provisioning a no-op and every
  assertion below it passes green against the previous run's data. The order of
  operations is the design — mark `deleting` first, so the resolver stops routing
  before anything is torn down; run `onDeprovision` inside the tenant's context;
  delete the record last, because the record is the only thing naming that
  storage. *(`@basaltkit/tenancy`)*
- **`search.reindex()` rebuilds an index from the rules that feed it.** A rule
  fed by events knows only what was created after the rule existed, so an
  application adding search to data it already had got a box that returned
  nothing for everything old — and an empty result is indistinguishable from
  "there is none". A rule's `backfill` yields **hook payloads**, not rows, so one
  `document` function serves both directions and a second mapping written by hand
  cannot drift from it. *(`@basaltkit/search`)*
- **The file domain has a durable store.** Eleven domains ship both a `-prisma`
  and a `-sqlite` backend without a single exception; `files` shipped neither —
  the only domain with a store contract and no durable implementation of it. The
  disk key is `files/<uuid>` and the uuid lived in the process, so a restart left
  every upload in the bucket, unreferenced and unmatchable to the document it
  was, while the application reported an empty list and nothing errored.
  *(`@basaltkit/files-prisma`)*
- **Documents have revisions.** `Files.upload` mints a new id and a new path on
  every call, so uploading the same contract twice produced two unrelated records
  with nothing linking them, and every application that needed "which draft am I
  reading?" wrote the same bookkeeping by hand. Not a `version` field on
  `FileRecord`: a file record describes bytes, a revision describes an editorial
  act, and each revision points at a whole file whose bytes are never
  overwritten. The store assigns the number and keys on
  `[tenantId, groupId, version]`, so the database refuses the duplicate that a
  read-the-latest-and-add-one race would produce.
  *(`@basaltkit/files-versions`)*

### Declarations instead of bookkeeping
- **`activityRule`** — `search` has `syncRule`, `realtime` has `bridgeRule`, and
  `activity`, probably the most common of the three, had only the fluent builder,
  which is for writing a line by hand inside a service. The cost of the asymmetry
  is not the thirteen `hooks.on()` calls an application writes instead; it is
  that the natural answer to "record this" becomes "call activity from
  `MatterService`", coupling the domain to the package the other two teach you to
  keep at arm's length. A rule never rethrows, and that is where it deliberately
  differs from `syncRule`: a history line that cannot be written must not fail
  the case closure that produced it. *(`@basaltkit/activity`)*
- **`canonicalDomain`** gives a new tenant an address. Every durable source reads
  domains from one key, and an application that never passes it creates tenants
  with none — silently, because `subdomainResolver` answers from the `Host`
  without consulting the table. The tenant serves traffic; what is missing is the
  record that the address belongs to it, so a custom domain cannot be attached
  and nothing stops a second tenant claiming the same one. Applied by
  `tenancy.create()`, so every creation path gets it instead of each one
  remembering. *(`@basaltkit/tenancy`)*
- **`authorize` decides who may see a hit.** A driver filters by the fields
  declared `filterable` and nothing else, which left search as the one surface
  with no answer for per-row visibility. The hook runs *after* the driver, which
  is what lets the package keep asking until the page is full — the thing a
  caller cannot do from outside without guessing an over-fetch factor. Copying
  the ACL into the index is the fast alternative and the wrong one: a stale index
  gives an old result, a stale ACL gives an unauthorized one.
  *(`@basaltkit/search`)*

### Answers that were quietly wrong
- **A permission is a capability, not a surface.** `matter:read` cannot tell
  "read my own case in the client portal" from "read the case with the litigation
  strategy in it", so a role granted the first also passed the guard on the
  second — and an authenticated portal client received `200` on an internal
  listing with their own case's strategy in the body. `meta.audience` describes
  who a route is for, and the default is the whole design: a route that declares
  no audience is unreachable by a confined role. Marking the small surface a
  restricted role may reach is a list somebody maintains; marking every route
  they may not is a list somebody forgets. *(`@basaltkit/permissions`)*
- **File versions read the ambient tenant, like `Files` always did.** They
  resolved the store key as `tenantId ?? SINGLE_TENANT_SCOPE`, skipping the
  request context, so a multi-tenant app that passed no explicit id — the normal
  case — wrote versions under `acme` and read them back under `default`:
  `history()` returned `[]`, `latest()` returned `null`, and `download()` raised
  for a file sitting on the disk. The rule now lives in one place, exported by
  `files` and used by both. *(`@basaltkit/files-versions`)*
- **The activity feed is scoped `required` under tenancy.** The old default meant
  "scope to the context tenant, run unscoped when there is none", so a feed query
  outside a tenant returned every tenant's records — and a feed line names a
  client in prose. The same rule `cache` already applied.
  *(`@basaltkit/activity`)*
- **Every HTTP adapter in `testing` is an optional peer.** `express` and `hono`
  already were; `fastify` was a plain dependency because it is the default
  adapter, and that asymmetry cost somebody half an hour. When the package moved
  its `fastify` range to `^2` while an app was still on `1.x`, pnpm installed
  both, and `createTestApp` resolved a `FASTIFY` token from a different copy than
  the one the app's `fastifyPlugin` registered: two `createToken('fastify')`
  calls, two identities, one container that cannot match them. The error said
  "No provider registered for token fastify" and named neither the package nor
  the version skew. A peer cannot duplicate. *(`@basaltkit/testing`)*

### Upgrading to 1.10

Packages are independent — bump only what you use. Two contracts changed, and
both edits are mechanical.

#### `app.server` is now awaited

```ts
const server = await app.server()   // was: app.server
```

`@basaltkit/testing` imports the adapter on demand, as it already did for
`express` and `hono`, so an app booted without any HTTP plugin still works and
the package never reaches for something the application may not have installed.
A token resolved through a dynamic import cannot be synchronous.

If `pnpm install` starts warning about an unmet `fastify` peer, that warning is
the point: it is the version skew that used to surface at runtime as a token
that does not exist.

#### The files store contract has three revisions

`@basaltkit/files` publishes a major. A custom `FileStore` needs three edits:

| Was | Is | Why |
| --- | --- | --- |
| `scanned?: boolean` | `scannedAt?: number` | The date derives the boolean and the boolean does not derive the date. "Scanned", with no idea when, stops being an answer the moment the scanner's rules change — the one thing antivirus rules reliably do. The `file:scanned` hook keeps its name: the event is not the field |
| `metadata?: Record<string, unknown>` | `metadata?: FileMetadata` | `Record<string, JsonValue>` — otherwise every durable store casts its way past its driver's JSON type, a cast each implementation repeats and has to get right |
| `FilePatch = Partial<Pick<…>>` | spelled out | So it can say that a key present with `undefined` **clears** the column while an absent key is left alone — which `Partial` of an optional field cannot express under `exactOptionalPropertyTypes`, and which is how a caller drops a stale scan result |

`prisma:sync` learns the files domain, so its models merge like every other one.

#### Prisma apps add a column for API key expiration

`@basaltkit/auth-prisma` 1.5.0 added a nullable `expiresAt` column to
`AuthApiKey` (`auth_api_keys`) for the new optional key expiration. Regenerating
the client is not enough — the database needs the column, or every API-key
request fails. Add a migration (`prisma migrate dev --name add_api_key_expires_at`),
which on PostgreSQL is:

```sql
ALTER TABLE "auth_api_keys" ADD COLUMN "expiresAt" TIMESTAMP(3);
```

With schema-per-tenant the column must exist in **every** tenant schema: add the
migration to your tenant migrations, then run `basalt tenant:migrate`. A test
suite that never issues an API key will not notice. Since `auth-prisma` 1.5.1 a
missing column raises `AUTH_API_KEY_SCHEMA_OUTDATED` with these instructions
instead of a raw Prisma `P2022`. `@basaltkit/auth-sqlite` needs nothing: it adds
the column itself when the database is opened.

#### Two packages debut at 0.1.0

`files-prisma` and `files-versions` publish `0.1.0`, not `1.0.0`. Neither has
been run against a real database by anyone yet, and joining the ecosystem's
semver commitment on their first day would promise something nobody has checked.
The version number says that more cheaply than a changelog nobody reads, and
leaves `1.0.0` for when it is earned.

---

## Previously — Basalt 1.9

> *The release **written by an application rather than by the framework**: a real
> legal SaaS was built on Basalt, and fifteen places where the framework made its
> author write code the framework should have written were closed.*

::: warning Zod 4 is required from 1.9 on
Twelve packages narrow their `zod` peer from `^3.24.0 || ^4.0.0` to `^4.0.0` —
see [Upgrading to 1.9](#upgrading-to-1-9).
:::

### Two official packages that did not fit together
- **Full-text search could not run through the Prisma client at all.** The
  language was passed as a bound parameter, which PostgreSQL will not accept
  where a `regconfig` belongs. Every query failed with a type error — not a
  degraded result, no result. Now cast at the call site. *(`@basaltkit/search-postgres`)*
- **The audit plugin aborted tenant provisioning.** Its default hook patterns
  included `tenancy:switched`, which fires outside any tenant context; the
  capture threw, and the error propagated out through `provision()`, marking the
  tenant failed. An application following both packages' defaults could not
  create a single tenant. The pattern is gone and both bridges now isolate their
  own failures. *(`@basaltkit/audit`)*
- **The admin package would not bundle for the browser it targets.** It imported
  `node:crypto` to mint one id, and the barrel re-exported it, so importing
  `defineResource` dragged a Node builtin into the bundle. Every application had
  to alias it away. *(`@basaltkit/admin`)*

### The framework now writes what every application was writing
- **`gate.actor()`** hydrates the caller's roles from the request scope, instead
  of each service reimplementing it — and getting a silent 403 when it forgot.
  *(`@basaltkit/permissions`)*
- **`accessRoutes()` and a dependency-free `permissions/match` subpath**, so a
  browser evaluates wildcards the same way the server does. Divergence there is
  not a bug you notice; it is a screen that renders a button nobody can press.
  *(`@basaltkit/permissions`)*
- **`inAppRoutes()`** serves the four endpoints every application wrote by hand.
  The routing shape was opinionated enough to leave out; the security rule was
  not, and is the same everywhere — **the recipient is the session, never a
  parameter**. *(`@basaltkit/notifications`)*
- **`tenantClient()`** for stores constructed before any request exists, instead
  of each application writing the same proxy. *(`@basaltkit/prisma`)*
- **`authRoutes({ password })`**, applied to registration *and* reset — a policy
  enforced on one of the two is not a policy. *(`@basaltkit/auth`)*

### Declarations that are now checked
- **`meta.subscribed` is validated at boot.** A plan name with a typo used to
  produce a route that quietly refused everyone. Every offending route is
  reported at once, because booting, fixing one, and booting again is a slow way
  to find three. *(`@basaltkit/subscriptions`)*
- **`RouteMeta` takes an index signature**, so a package can extend route
  metadata without every application casting. *(`@basaltkit/http`)*
- **`prisma:sync` distinguishes the central schema from a tenant's.** The most
  obvious flag used to put central tables inside every tenant's schema, silently.
  *(`@basaltkit/prisma`)*

### Generated code that matches the project it is generated into
- **`defineResource` accepts field labels and translated enum options.** Labels
  came from the field name — `taxId` read *Tax Id* — and enum options came out as
  the stored values. In an application written in another language the generated
  form ended up half in English and half in database values, which was enough to
  make hand-writing it the easier option. *(`@basaltkit/admin`)*
- **The generator takes a configurable Prisma client**, and project-wide
  defaults. An application with a second client — schema-per-tenant, a read
  replica — had to hand-edit every generated repository. *(`@basaltkit/generator`)*
- **`authorize` receives the container**, so a realtime subscription gate can
  reach a service without a module-level variable filled from someone else's
  boot. *(`@basaltkit/realtime`)*
- **The SDK passes native bodies through untouched** — `FormData`, `Blob`,
  `ReadableStream` — and accepts an `AbortSignal` and per-call headers.
  *(`@basaltkit/sdk`)*

### Upgrading to 1.9

Packages are independent — bump only what you use. One change is required of
everyone, and one behaviour tightened.

#### Zod 4 is required

Twelve packages — `admin`, `audit-viewer`, `auth`, `comments`, `env`, `fastify`,
`files`, `http`, `mcp`, `sdk`, `subscriptions`, `teams` — narrow their `zod` peer
from `^3.24.0 || ^4.0.0` to `^4.0.0`. Each publishes a new major for it.

```bash
pnpm add zod@^4
```

The second half of that old range had not been exercised in a long time: this
repository tests against zod 4 only, so zod 3 was a compatibility promise nobody
was checking. Supporting a major version you never run is worse than not
supporting it — it holds the API surface back while promising something that
would break on first contact.

Zod's own [3-to-4 migration guide](https://zod.dev/v4/changelog) covers the API
changes. The two that touch Basalt users most:

- `z.string().datetime()` becomes `z.iso.datetime()`
- error customisation moves from `message` / `invalid_type_error` to a single
  `error` parameter

The peer asks for `^4.0.0`, not the newest 4.x — requiring the version this
repository happens to test would force every consumer to move in step with us
for no reason.

#### An unknown plan name now fails the boot

`meta.subscribed: 'pró'` against a catalogue containing `pro` used to boot fine
and refuse every caller at runtime. It is now an error at startup, listing every
offending route at once. If a boot starts failing after the upgrade, the route
was already dead — you can now see it.

---

## Previously — Basalt 1.8

> *The release where **multi-tenant persistence stopped failing quietly**: four
> distinct ways a tenant could end up with the wrong data — or no data at all —
> while every layer reported success.*

### A tenant is never served the wrong data quietly
- **Schema-per-tenant on a database that cannot do it.** It relies on a schema
  being a namespace *inside* a database. In MySQL a "schema" **is** a database;
  SQLite has no equivalent. Configuring it there used to surface as a raw
  `CREATE SCHEMA` syntax error at tenant-creation time, far from the config that
  caused it. Now refused where the configuration is read — at boot, and once
  before any migration runs. *(`@basaltkit/prisma` 1.5)*
- **Migrations read from the wrong history.** `migrations.path` belongs to your
  `prisma.config.ts`, not to the schema file, so pointing `--schema` at the tenant
  models left Prisma applying the **central** migration history. The tenant came
  up holding `_prisma_migrations` and none of its own tables. Pass `configPath`
  instead. *(`@basaltkit/prisma` 1.5)*
- **A migration that succeeded without doing anything.** `prisma migrate deploy`
  exits 0 when it finds no migrations, so a missing or empty migrations directory
  looked exactly like success — and the tenant was marked ready.
  `migrateTenants` now counts the tenant's own tables and reports `ok: false`.
  It counts *tables*, not migrations, because `db push` is a legitimate strategy
  with no migration history at all. *(`@basaltkit/prisma` 1.6)*
- **Which strategy works on which database** is now stated in the docs, per
  strategy and per engine, instead of being inferable from an error message. See
  [Which strategy works on which database](/guide/database-per-tenant#which-strategy-works-on-which-database).

This is deliberately a set of **guards, not abstractions**. Translating
`mode: 'schema'` into a separate database on MySQL would be doing
database-per-tenant under a name that says otherwise — different backups,
different connection limits, different migration cost. That belongs in your
config as a decision, not in the framework as a silent substitution.

### Central and tenant routes in one app
`required: true` rejected any request that resolved no tenant — on **every**
route, which no app can live with: a health check has no tenant to send, and a
load balancer will never set the header. Two ways out now, and they compose:

```ts
// Deny by default…
tenancyPlugin({ source, resolvers, required: true })

// …and let each route say what it is, next to its handler.
route({ method: 'GET', url: '/pricing',  meta: { tenant: false }, handler })
route({ method: 'GET', url: '/invoices', meta: { tenant: true },  handler })
```

`meta.tenant` overrides the app-wide default in both directions, so the decision
lives with the route and survives a rename — unlike a path list in another file,
which stops matching silently. `required: { except: [...] }` remains for paths
you do not own, such as routes mounted by another package.
*(`@basaltkit/tenancy` 1.7 and 1.8)*

`@basaltkit/http` 1.16 passes the route being served to **enrichers**, not just
guards — which is what makes the above possible, and why it behaves identically
on Fastify, Express and Hono rather than through three parallel implementations.

### One app, both worlds
`prismaPlugin` already accepted `client` (for the tenant-less context) alongside
`schemaPerTenant`, but that was one undocumented sentence — so in practice it was
undiscoverable. With both set, `db()` returns the central client on central
requests and the tenant's client on tenant ones:

```ts
route({ method: 'GET', url: '/users', meta: { tenant: false }, handler: async () =>
  db<PrismaClient>().authUser.findMany(),  // central on the apex, tenant on a subdomain
})
```

The same `/auth/login` then authenticates central users on the apex and tenant
users on a subdomain — because the two look in different schemas, not because a
handler checks. Routes mounted by other packages (`authRoutes()`, `mfaRoutes()`)
are covered by mapping `meta` over them. See
[Serving central and tenant routes from one app](/guide/database-per-tenant#serving-central-and-tenant-routes-from-one-app),
including the trade-off: with `client` set, a mis-scoped tenant route reads the
central database instead of failing loudly, and `required: true` is what keeps
that safe.

### Upgrading to 1.8

Packages are independent — bump only what you use. Nothing in 1.8 is a breaking
change, but two behaviours tightened:

1. **`migrateTenants` can now fail a tenant it previously passed.** A migration
   that produced no tables reports `ok: false` with
   `PRISMA_TENANT_SCHEMA_EMPTY`. That is almost always a missing or misdirected
   migration history — but if a tenant legitimately starts empty, pass
   `verifyTables: false`.
2. **Schema-per-tenant is refused at boot on MySQL and SQLite.** It never worked
   there; it used to fail later and less clearly. Move to database-per-tenant
   (`forTenant`, or `{ mode: 'database', urlFor }`), which gives stronger
   isolation anyway.

---

## Previously — Basalt 1.7

> *The release where **no core forces a backend on you** — and where a failed
> request became visible on every adapter.*

### A core defines the contract, a backend is a package
`queue`, `storage`, `cache` and `mailer` each shipped a **string shorthand** for
one backend — `connection`, `driver: 's3'`, `driver: 'redis'`, `driver: 'smtp'`.
A string cannot be resolved lazily, so the shorthand *is* what forced the
dependency: an app on Azure Blob still installed 4.4 MB of AWS SDK, and one
sending mail through Resend still installed an SMTP client it never opened.

| Core | Was forced on everyone | Now |
| --- | --- | --- |
| `@basaltkit/queue` **2.x** | `bullmq` | `@basaltkit/queue-bullmq` **1.0** |
| `@basaltkit/storage` **2.x** | `@aws-sdk/client-s3` — **4.4 MB** | `@basaltkit/storage-s3` **1.0** |
| `@basaltkit/cache` **2.x** | `ioredis` — **1.5 MB** | `@basaltkit/cache-redis` **1.0** |
| `@basaltkit/mailer` **2.x** | `nodemailer` — **688 KB** | `@basaltkit/mailer-smtp` **1.0** |

An app using local storage, the in-memory cache and Resend drops **6.5 MB** of
client libraries it never called. It also ends an inconsistency that had become
hard to defend: adding a fifth queue backend was easy, adding a second
*first-class* one was not, because the core had a favourite. The repo-wide
driver-boundary tripwire's allowlist, which recorded exactly these four as known
debt, is now empty.

### A failed request is visible on every adapter
Whether an error reached your terminal used to depend on which adapter you had
mounted — exactly the difference the neutral pipeline exists to erase. Express and
Hono logged **nothing at all**: a 500 left no server-side trace. Fastify logged
5xx only, and only from one of its two catch sites. Now every 4xx and 5xx is
reported on all three, as structured fields rather than an interpolated string.
*(`@basaltkit/http` 1.15)*

### `main` is protected
`verify` (Node 22 and 24), `coverage`, `analyze` and CodeQL are now **required**
checks, enforced for administrators, with direct pushes blocked. Before this the
branch was unprotected.

### Upgrading to 1.7
The four capability majors are the only breaking changes, and each is one import
and one line:

```diff
-queuePlugin({ connection: REDIS_URL, jobs, workers })
+bullmqQueuePlugin({ connection: REDIS_URL, jobs, workers })

-storagePlugin({ disks: { docs: { driver: 's3', bucket } } })
+storagePlugin({ disks: { docs: s3Disk({ bucket }) } })

-cachePlugin({ driver: 'redis', url })
+cachePlugin({ driver: redisCache(url) })

-mailerPlugin({ driver: 'smtp', smtp: { url }, from })
+mailerPlugin({ driver: smtpMailer({ url }), from })
```

You are **not** affected if you already passed a driver instance, used
`driver: 'local'`, the default in-memory cache, or the `log`/`memory` mailer
drivers. TypeScript flags every case at compile time, because the removed strings
left their unions. Full detail in [Driver packages](/guide/driver-packages).

---

## Previously — Basalt 1.6

> *"Basalt 1.6" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.6 is the release where **the framework guarantees what it promises**.
Three architecture review cycles took the project's stated principles — adapter
neutrality, the dev-only AI boundary, "SaaS is opt-in", secure-by-default — and
turned each one from a convention people had to remember into a **CI tripwire
that fails the build**. Along the way the reviews found, and fixed, real bugs
those principles were supposed to prevent.


### Promises became guarantees
Five new machine-enforced boundaries, each with a test that fails the build:
- **Adapter neutrality** — no feature package may depend on a specific HTTP
  adapter. Ten packages had drifted into importing the route contract *through*
  `@basaltkit/fastify`, forcing Fastify into Express/Hono apps; all repointed to
  `@basaltkit/http`. A cross-adapter conformance suite now runs the same neutral
  contract on all three. *(`@basaltkit/testing` gained `createTestApp({ adapter })`.)*
- **SaaS is opt-in** — a generic package may never *require* tenancy. Six had
  started to: `audit.trail()` threw on every call in a non-tenant app, pushing
  you to a method the docs call a dangerous escape hatch; `search` even required
  `tenantId` on write while reads threw. The new `apps/beyond-saas` boots a real
  app with 18 generic plugins and **no tenancy** to keep it honest.
  See [Beyond SaaS](/guide/beyond-saas).
- **The AI layer stays dev-only** — an import-graph test keeps `@basaltkit/ai`
  and `@basaltkit/ai-mcp` out of any application runtime.
- **DI lifetime safety** — the container now fails loudly on a *captive
  dependency* (a singleton that would freeze one request scope's instances
  app-wide) instead of silently serving stale objects. *(`@basaltkit/core` 1.3)*
- **Declared guards must be enforced** — a route that declares `meta.auth`,
  `can`, `teamRole`, `scopes`, `subscribed` or `feature` with no plugin to
  enforce it now **fails at boot**, naming the plugin that fixes it, instead of
  serving unprotected traffic. Opt out deliberately with `allowUnguardedMeta`.

### Security
- **Billing**: checkout/portal/invoice routes shipped **without auth** (anyone
  could open a tenant's payment portal), and `checkout()` overwrote the
  subscription so a genuinely-signed webhook could **activate an escalated
  plan**. Both fixed, with the escalation reproduced as a test first.
  *(`@basaltkit/subscriptions` 2.7)*
- **Refresh-token reuse**: `markUsed` was read-then-write, so two concurrent
  refreshes each returned a **valid** token pair. Now a compare-and-swap across
  all stores. *(`@basaltkit/auth` 1.8)*
- Stored-XSS via signed file URLs closed (`Content-Disposition: attachment` by
  default), server-rendered UIs got a **route-scoped, hash-locked CSP**, mail
  bodies are redacted in production, and `html\`\`` makes escaping the default
  path for HTML mail.

### Reliability under load
Multi-replica deployments got the guarantees they were missing: the scheduler's
`.onOneServer()` + `ScheduleLock` (no more every-replica double-runs), an event
outbox that actually honours at-least-once, RabbitMQ publisher **confirms before
ack** (closing a job-loss window), and Kafka redelivery instead of silent loss.
Five process-crash paths were eliminated — one dead WebSocket or a Redis blip
could previously take down a domain write.

### The docs are now the official reference
With API generation dropped, the guides *are* the reference: 27 guides (EN + PT)
rewritten to one didactic arc — what it is → mental model → runnable quickstart →
recipes → full options table → failure modes keyed on real error codes — and
[Core concepts](/guide/concepts) documents the internal API (container lifetimes,
plugin phases, the route pipeline, metadata buckets, writing your own
guard/enricher) well enough to build a third-party package from the docs alone.
Writing them surfaced four more real bugs.

### Upgrading to 1.6

Packages are independent — bump only what you use. Two things to know:

1. **The boot check is new.** If your app declares `meta.auth` (or `can`,
   `teamRole`, `scopes`, `subscribed`, `feature`) on a route but never registers
   the enforcing plugin, it now **fails at boot** with the plugin named. That
   route was serving unprotected before; register the plugin, or opt out with
   `allowUnguardedMeta` if your edge handles it.
2. **Some defaults tightened** (documented per package): file URLs default to
   `attachment`, mail bodies are redacted in production, cache scoping fails
   closed *when tenancy is active*, and `meta.can` rejects non-string values
   instead of silently skipping the check.

---

## Previously — Basalt 1.5

> The AI developer experience **in your editor and any MCP client** — Claude
> Desktop, Claude Code, or your own — plus the TypeScript 7 move across the whole
> repository.

### AI development over MCP
- **`@basaltkit/ai-mcp`** — a **dev-only** MCP bridge that exposes Basalt's AI
  workflows as MCP tools: `basalt_analyze`, `basalt_doctor`, `basalt_plan`,
  `basalt_review`, and a workspace-confined `basalt_make`. Point an MCP client at
  your app (`npx @basaltkit/ai-mcp --cwd=<app>`) and drive the whole
  analyze → plan → make → review loop from Claude Desktop/Code. It also ships
  **project resources** (`basalt://project/*`, `basalt://knowledge/architecture`)
  and **workflow prompts** (`plan-feature`, `scaffold-resource`, `harden-tenancy`,
  `add-rbac`), over **stdio** (default) or an opt-in **HTTP** transport. Like the
  rest of the AI surface, it is never a runtime dependency of your app.
  *(`@basaltkit/ai-mcp` 0.1)* → see [AI in your editor (MCP bridge)](/guide/ai-mcp).
- **`@basaltkit/mcp-core`** — a **zero-dependency** MCP core extracted from the
  runtime `@basaltkit/mcp`: the JSON-RPC protocol, a generic tool/resource/prompt
  server, stdio + HTTP transports, and progress/cancellation. Build your own MCP
  server on it without pulling the framework runtime into the graph; the runtime
  `@basaltkit/mcp` now sits on top of it with an unchanged public API.
  *(`@basaltkit/mcp-core` 0.3)* → see [Building an MCP server](/guide/mcp-core).
- **Safe by design.** `basalt_make` previews by default (clash detection + unified
  diffs, no writes); applying is explicit (`mode:"apply"`), overwrites need `force`,
  migrations are double-gated, and every write is confined to the target workspace.

### TypeScript 7 everywhere
- **The root now runs on TypeScript 7 too**, retiring the last `5.9` pin that
  existed only for linting — the whole repository, packages and root, is on the TS 7
  native compiler. ESLint is **temporarily paused** (a documented no-op, re-enabled
  with a one-line change) until `typescript-eslint` ships official TS 7 support;
  `typecheck` stays fully active, so real type errors are never hidden.

### Security hardening
- **The opt-in HTTP transport validates `Origin` and `Host`.** `@basaltkit/mcp-core`'s
  HTTP server already bound to loopback; it now also rejects cross-site (`Origin`)
  and DNS-rebinding (`Host`) requests, so a browser page can't drive the local dev
  bridge. Loopback-only by default, with an explicit allow-list escape hatch for
  deliberate remote/CI use. *(`@basaltkit/mcp-core` 0.3, minor)*

### Documentation
- **Exhaustive, bilingual (EN + PT) guides** for the AI/MCP dev-tooling stack:
  [AI in your editor (MCP bridge)](/guide/ai-mcp) and
  [Building an MCP server](/guide/mcp-core) — from a beginner quickstart to an
  advanced reference of every tool, resource, prompt, transport and the safe-make
  model.

### Upgrading (1.5)

Packages are independent — bump only what you use. This wave is additive: the new
`@basaltkit/ai-mcp` and `@basaltkit/mcp-core` are brand-new **dev-only** tooling,
`@basaltkit/mcp`'s runtime public API is unchanged, and the TypeScript 7 root move
is internal. New Basalt apps can opt into the bridge with `create-basalt --mcp`.

---

## Previously — Basalt 1.4

> Foundations-and-hardening: it modernized the toolchain, put real teeth back into
> the quality and security gates, and graduated the AI surface to a stable 1.0.

### TypeScript 7 toolchain
- **The whole monorepo compiles, type-checks and tests on the TypeScript 7 native
  compiler.** Every package's build moved from `tsup` to plain `tsc` — dropping
  `rollup-plugin-dts`, which is incompatible with the TS 7 compiler — with no change
  to the published `exports`/`types` contracts.

### AI & MCP → 1.0
- **`@basaltkit/ai` 1.0** — the dev-only AI developer experience: a provider-agnostic
  engine plus the `basalt ai` CLI (`analyze`, `doctor`, `plan`, `make`, `review`),
  under a stable public API. *(`@basaltkit/ai` 1.0)*
- **`@basaltkit/mcp` 1.0** — the runtime Model Context Protocol surface: expose
  opt-in routes as tools over **HTTP (any adapter)** or **stdio**, and consume
  external MCP servers as a client — all through the neutral route pipeline, no
  external SDK. *(`@basaltkit/mcp` 1.0)*

### Quality gate
- **The coverage gate is enforced again.** It had gone informational; it now blocks
  regressions, scoped to unit-testable runtime code. Real aggregate at re-baseline:
  statements 93% · branches 85% · functions 91% · lines 95%.

### Security hardening
- **Every runtime-reachable ReDoS finding is eliminated.** Quadratic
  trailing-character strips were rewritten as linear, non-regex trims across
  `audit`, `tenancy`, `mailer`, `auth`, `sdk` and `search-elasticsearch`, and the
  PII redactor length-bounds its input before matching. The code-scanning backlog is
  at **zero open alerts**.
