# What's new in Basalt 1.10

> *"Basalt 1.10" is the umbrella label for this wave of work; the `@basaltkit/*`
> packages ship independently (see [Versioning](/guide/versioning)). Below is what
> landed and the package version that carries it.*

::: warning Two contracts changed
`@basaltkit/files` revises its store contract, and `app.server` in
`@basaltkit/testing` is now awaited. Both edits are mechanical — see
[Upgrading](#upgrading).
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

## Highlights

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

## Upgrading

Packages are independent — bump only what you use. Two contracts changed, and
both edits are mechanical.

### `app.server` is now awaited

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

### The files store contract has three revisions

`@basaltkit/files` publishes a major. A custom `FileStore` needs three edits:

| Was | Is | Why |
| --- | --- | --- |
| `scanned?: boolean` | `scannedAt?: number` | The date derives the boolean and the boolean does not derive the date. "Scanned", with no idea when, stops being an answer the moment the scanner's rules change — the one thing antivirus rules reliably do. The `file:scanned` hook keeps its name: the event is not the field |
| `metadata?: Record<string, unknown>` | `metadata?: FileMetadata` | `Record<string, JsonValue>` — otherwise every durable store casts its way past its driver's JSON type, a cast each implementation repeats and has to get right |
| `FilePatch = Partial<Pick<…>>` | spelled out | So it can say that a key present with `undefined` **clears** the column while an absent key is left alone — which `Partial` of an optional field cannot express under `exactOptionalPropertyTypes`, and which is how a caller drops a stale scan result |

`prisma:sync` learns the files domain, so its models merge like every other one.

### Two packages debut at 0.1.0

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
