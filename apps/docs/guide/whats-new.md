# What's new in Basalt 1.7

> *"Basalt 1.7" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

Basalt 1.7 is the release where **you stop paying for backends you never use**,
and where multi-tenant persistence stops failing quietly. The four capability
cores each forced one backend's client on every consumer; all four are now
separate packages, and the tripwire that recorded them as known debt has an empty
allowlist. Then a run of real-world use found four ways a tenant could end up with
the wrong data — or no data — while every layer reported success.

## Highlights

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
*first-class* one was not, because the core had a favourite. Migration is one
import and one line per capability — see [Driver packages](/guide/driver-packages).

### Multi-tenant persistence fails loudly now
Four separate ways a tenant could be served wrong data, all found by using the
framework rather than reading it:

- **Schema-per-tenant on a database that cannot do it.** It relies on a schema
  being a namespace *inside* a database. In MySQL a "schema" **is** a database;
  SQLite has no equivalent. Configuring it there used to surface as a raw
  `CREATE SCHEMA` syntax error at tenant-creation time, far from the config that
  caused it. Now refused where the configuration is read — at boot, and before any
  migration runs. *(`@basaltkit/prisma` 1.5)*
- **Migrations read from the wrong history.** `migrations.path` belongs to your
  `prisma.config.ts`, not to the schema file, so pointing `--schema` at the tenant
  models left Prisma applying the **central** migration history. Pass
  `configPath` instead. *(`@basaltkit/prisma` 1.5)*
- **A migration that succeeded without doing anything.** `prisma migrate deploy`
  exits 0 when it finds no migrations, so a missing or empty migrations directory
  looked exactly like success: the tenant came up holding `_prisma_migrations` and
  not one table of its own, marked ready. `migrateTenants` now counts the tenant's
  own tables and reports `ok: false`. It counts *tables*, not migrations, because
  `db push` is a legitimate strategy with no migration history at all.
  *(`@basaltkit/prisma` 1.6)*
- **Which strategy works on which database** is now stated in the docs, per
  strategy and per engine, instead of being inferable from an error message.

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
*(`@basaltkit/tenancy` 1.7 and 1.8; `@basaltkit/http` 1.16 now passes the route to
enrichers, so this behaves identically on Fastify, Express and Hono.)*

One app can also serve **both** worlds from one `prismaPlugin` registration —
`client` for the tenant-less context, `schemaPerTenant` for the rest — so the same
`/auth/login` authenticates central users on the apex and tenant users on a
subdomain, because the two look in different schemas rather than because a handler
checks. See
[Serving central and tenant routes from one app](/guide/database-per-tenant#serving-central-and-tenant-routes-from-one-app).

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

## Upgrading

Packages are independent — bump only what you use. The four capability majors are
the only breaking changes, and each is one import and one line:

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

One behaviour change worth knowing: `migrateTenants` now reports `ok: false` for a
tenant whose migration produced no tables. If a tenant legitimately starts empty,
pass `verifyTables: false`.

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
