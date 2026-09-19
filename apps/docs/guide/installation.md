# Installation

There are two ways in. `create-basalt` scaffolds a production-shaped app in one
command and only writes the features you pick — nothing dead ships. Or you add
individual `@basaltkit/*` packages to an app you already have: every package is
ESM with types, follows the same plugin contract, and works on its own. This
page covers both, plus the `basalt` CLI that generates code once you're inside a
project.

[[toc]]

## Requirements

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | **22 or newer** (`engines: >=22`) | The framework targets modern Node; CI runs the whole monorepo on 22 and 24 |
| Package manager | pnpm (recommended), npm, yarn or bun | Only `--ui` is pnpm-only — it scaffolds a pnpm workspace |
| Node 22.5+ | for `node:sqlite` | The zero-dependency `*-sqlite` stores (`auth-sqlite`, `teams-sqlite`, …) use Node's built-in SQLite |
| Node 22.6+ | for `basalt dev` without `tsx` | The dev runner falls back to `node --watch --experimental-strip-types` when `tsx` isn't installed |
| PostgreSQL / Redis | production only | Prisma-backed stores need Postgres or MySQL; BullMQ queues and the Redis cache driver need Redis |

Nothing beyond Node is required to *start* — the scaffold boots on in-memory
stores. See [Persistence & durable stores](/guide/persistence) for the swap.

## Scaffold a new app

Your package manager's `create` command downloads and runs the scaffolder on the
spot — nothing to install first:

```bash
pnpm create basalt my-saas
# or
npm create basalt my-saas
# or
yarn create basalt my-saas
# or
bun create basalt my-saas
```

Run it **with no name** in a terminal and you get the interactive wizard
instead. Pass flags (or `-y`) to skip every question.

### The interactive wizard

The wizard runs only when you gave no name, stdin is a TTY, and you didn't pass
`--yes` — so CI and piped runs always take the flag-driven path. It asks, in
order:

1. **Project name** — defaults to `my-saas`, validated as an installable npm
   package name (lowercase, no spaces, max 214 characters, optional `@scope/`).
2. **Choose a starting point** — one of the presets below.
3. **Select features** — only for the `custom` preset; multi-select with
   tenancy and auth pre-ticked.
4. **Package manager** — pnpm / npm / yarn / bun, defaulting to the one that
   invoked the command.
5. **Install dependencies now?** and **Initialize a git repository?** — both
   default to yes.
6. A summary, then **Create project?** — answering no (or Ctrl+C) prints
   `Cancelled.` and exits with code 130, writing nothing.

### Presets

| Preset | Features |
| --- | --- |
| **SaaS starter** | tenancy + auth + billing + CLI |
| **API only** | auth + MCP — no tenancy, no UI |
| **Full stack** | everything, including the web UI |
| **Minimal** | none — add them later |
| **Custom** | you pick from the feature list |

## Scaffolder flags

| Flag | Default | What it does |
| --- | --- | --- |
| `<name>` (positional) | — | Project name and, unless `--dir` says otherwise, the target folder |
| `--dir=<path>` | `./<name>` | Destination folder |
| `--no-tenancy` | tenancy **on** | Skip multi-tenancy (`@basaltkit/tenancy`, header + subdomain resolvers) |
| `--no-auth` | auth **on** | Skip authentication (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`, `mfaRoutes()`) |
| `--billing` | off | Include subscriptions and plans (`@basaltkit/subscriptions`) |
| `--ui` | off | Add a React + shadcn `web/` frontend — see [Web UI](/guide/web-ui). **Forces pnpm** |
| `--cli` | off | Add `bin/basalt.ts`, the `basalt` script, generators and `prisma:sync` |
| `--mcp` | off | Expose opted-in read-only routes as MCP tools at `POST /mcp`, plus a `.mcp.json` for AI dev tools — see [MCP](/guide/mcp) |
| `--install` / `--no-install` | on in a TTY, off in CI | Install dependencies at the end |
| `--git` / `--no-git` | on in a TTY, off in CI | `git init` plus an initial commit |
| `--offline` | off | Skip the npm registry lookup and use the dependency ranges bundled with this create-basalt release |
| `--pm=<manager>` | auto-detected | Force `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Accept all defaults, no prompts (also disables the wizard) |
| `-h`, `--help` | — | Print usage and exit |

```bash
pnpm create basalt my-saas --billing --cli --install --git   # full stack, installed and committed
npm create basalt service-api --no-tenancy --no-auth         # minimal API
pnpm create basalt agent-api --mcp -y                        # API + MCP tools, no prompts
```

The package manager is detected from `npm_config_user_agent` (the variable npm,
pnpm, yarn and bun all set), falling back to npm. `--install` and `--git` are
tri-state: an explicit flag always wins, and only when you pass neither does the
environment decide — a TTY that isn't CI gets both, everything else gets
neither, so automation never gets a surprise install.

New projects get the **latest published version** of every dependency: before
writing files the scaffolder asks the registry (`npm_config_registry`, else
`registry.npmjs.org`) for each package's `latest` and writes `^<latest>`.
`@basaltkit/*` always takes the latest release; third-party packages (TypeScript,
Vitest, React, Vite, Tailwind, …) take it only on the major the templates are
written for — a newer major keeps the bundled range and prints a `Note:`. When the
registry can't be reached, the bundled ranges are used with a single `Warning:`
line; the scaffold never fails because of it. `--offline` skips the lookup.

A third-party `latest` published **inside pnpm's release-age window**
(`minimumReleaseAge` — pnpm 11 defaults it to one day) keeps the bundled range
too: `^<latest>` of a version published an hour ago can't be installed under that
policy, while the bundled range lets pnpm pick the newest *mature* version
itself. The age comes from one cheap `HEAD <registry>/<name>` per third-party
package (its `last-modified`); when it can't be proven, the bundled range is kept
and a `Note:` says so. The window follows `pnpm_config_minimum_release_age` /
`npm_config_minimum_release_age` when set. `@basaltkit/*` is never checked — the
generated `pnpm-workspace.yaml` excludes the scope from the policy.

::: warning `--ui` requires pnpm
The `web/` frontend is a member of a pnpm workspace (`pnpm-workspace.yaml`),
which npm, yarn and bun can't install or run. Ask for `--ui` with another
manager and the scaffolder tells you it is switching to pnpm, then does.
:::

## What gets generated

Every project gets the same skeleton; the feature flags only change what's
inside it:

| Path | Contents |
| --- | --- |
| `src/env.ts` | `defineEnv` over `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` (+ `APP_SECRET` via `secret({ minLength: 32 })` with auth), with `{ prefix: 'MY_SAAS' }` — every variable is read as `MY_SAAS_<NAME>` first, falling back to the bare name (see [`--env-file` never overrides exported variables](#env-file-never-overrides-exported-variables)) |
| `src/app.ts` | `buildApp()` — config, logger, events, security headers + a global rate limit, then tenancy/auth/billing/MCP/CLI as selected. With tenancy + auth: `teamsPlugin()` + `tenantMembershipPlugin()` (authenticated requests for a tenant the user is not a member of get `403`) and a dev-only seed adding registrants to the `demo` tenant |
| `src/routes.ts` | `GET /` (a friendly index) and `GET /health` |
| `src/server.ts` | Boots, resolves `FASTIFY`, listens, and shuts down on `SIGINT`/`SIGTERM` |
| `src/dev.ts` | The `pnpm dev` entry: sets `NODE_ENV=development` unless already set, then loads `server.ts` |
| `tests/app.test.ts` | A smoke test that boots the app and hits `/` and `/health` |
| `package.json` | Scripts `dev` (`tsx watch src/dev.ts`), `start` (`tsx src/server.ts` — an unset `NODE_ENV` counts as production), `test`, `typecheck` — plus `basalt` with `--cli`. `@basaltkit/*` ranges track each package's current release line |
| `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `tsconfig.json`, `pnpm-workspace.yaml` | Project scaffolding (`.dockerignore` keeps `.env` and keys out of image layers; `.env.example` uses the app-prefixed names and, with the README, explains the [`--env-file` precedence pitfall](#env-file-never-overrides-exported-variables); `pnpm-workspace.yaml` excludes `@basaltkit/*` from `minimumReleaseAge` and documents the [pnpm 11 settings](#pnpm-11-release-age-and-verifydepsbeforerun)) |
| `bin/basalt.ts` | With `--cli`: the CLI entrypoint wiring the generators and `prisma:sync` |
| `.mcp.json` | With `--mcp`: registers the **dev-only** `basalt-ai-mcp` bridge for MCP clients |
| `web/…` | With `--ui`: the React + shadcn frontend, a pnpm workspace member |

Then the usual next steps:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000  (health check at /health)
pnpm test
```

For a guided end-to-end run, see [Getting Started](/guide/getting-started).

### `--env-file` never overrides exported variables

`src/env.ts` validates `process.env` and nothing else — the scaffold does not load
`.env` for you. When you launch with `node --env-file=.env` (or
`tsx --env-file=.env`), Node **only fills variables that are not already set**:
a value exported in your shell always wins. With generic names this bites
quietly — in a terminal where another project exported `DATABASE_URL` or `PORT`,
the app boots against *that* database or port and fails only on the first request
that touches it.

**The fix the scaffold applies: an app-specific prefix.** `src/env.ts` passes
`prefix` to `defineEnv`, derived from the project name (`my-saas` → `MY_SAAS`),
and `.env.example` uses the prefixed names:

```ts
// src/env.ts — generated
export const env = defineEnv(
  {
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-please-change-me' }),
  },
  { prefix: 'MY_SAAS' },
)
```

```bash
# .env.example — generated
MY_SAAS_PORT=3000
MY_SAAS_HOST=0.0.0.0
MY_SAAS_LOG_LEVEL=info
NODE_ENV=development            # never prefixed — a Node-wide convention
# MY_SAAS_APP_SECRET=           # with auth
```

Each variable is read as `MY_SAAS_<NAME>` first and **falls back** to the bare
`<NAME>`, so a deployment that already exports the generic names keeps booting
while a stray `PORT` in your shell no longer wins. The shape's keys are
untouched — the app still reads `env.PORT`. To drop the fallback and require
the prefixed names only, write
`prefix: { value: 'MY_SAAS', fallback: false }`. When a variable is missing the
report names what was looked for —
`MY_SAAS_DATABASE_URL (or DATABASE_URL): Required`. Full rules:
[Configuration → App-specific prefixes](/guide/config#app-specific-prefixes).

Two habits that still help:

- When in doubt, `env | grep DATABASE_URL` before `pnpm dev`, or start with a
  clean slate: `env -u DATABASE_URL pnpm dev`.
- Once a database is wired, log its target at boot (host and database name,
  never the password) so a wrong one is visible in the first line of output.

### pnpm 11: release age and `verifyDepsBeforeRun`

Two pnpm 11 behaviours shape the generated `pnpm-workspace.yaml`:

- **`minimumReleaseAgeExclude` is first-match-wins by package name.** Two entries
  for the same package (`'@types/node@22.20.4'` and `'@types/node@26.6.2'`) do not
  add up — only the first applies. Exclude several versions of one package with a
  single union entry, as the generated comment shows:

  ```yaml
  minimumReleaseAgeExclude:
    - '@basaltkit/*'
    - '@types/node@22.20.4 || 26.6.2'
  ```

- **`verifyDepsBeforeRun` defaults to `install`.** Before every `pnpm <script>`
  *and* `pnpm exec`, pnpm checks that `node_modules` matches the manifests of
  every workspace project (including `web/` with `--ui`); when it doesn't, it runs
  `pnpm install` first — network and supply-chain checks included. So
  `pnpm basalt make:resource …` is effectively `pnpm install && basalt …` right
  after any dependency change. Two conscious ways out:

  ```bash
  node_modules/.bin/tsx bin/basalt.ts make:resource Project   # no pnpm, no pre-run check
  ```

  or uncomment `verifyDepsBeforeRun: warn` in `pnpm-workspace.yaml` — pnpm then
  only warns, and running `pnpm install` after dependency changes is on you. The
  scaffold keeps pnpm's default and the `basalt` script as `tsx bin/basalt.ts`.

## Choose an HTTP adapter

Routes are written once and run on any of three adapters — pick the one for your
stack (see [HTTP Adapters](/guide/adapters)):

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify fastify          # Fastify
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express          # Express
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server  # Hono
```

The scaffolder always writes Fastify; swapping later is a one-line change,
because `route()` and the guards live in the neutral `@basaltkit/http`
contract.

## Add to an existing app

Basalt packages adopt incrementally. To add multi-tenancy to an app you already
have, install just those pieces — it works the same on any adapter:

```bash
pnpm add @basaltkit/core @basaltkit/tenancy
```

The full catalogue is in the [package reference](/reference/packages), and
[Migrating from Express](/guide/migrating-from-express) walks through adopting
the framework a capability at a time.

## Scaffold inside a project

With `--cli` (or after adding `@basaltkit/cli` + `@basaltkit/generator`
yourself), `pnpm basalt` generates whole resource verticals:

```bash
pnpm basalt make:resource Project                        # in-memory repository
pnpm basalt make:resource Project --prisma               # Prisma-backed + a schema.prisma model
pnpm basalt make:resource Project --prisma --soft-delete # + a deletedAt column & restore
pnpm basalt make:service Project                         # just one artifact
```

`make:resource` emits a schema, repository, service, DI plugin, typed CRUD
routes and a test into `src/modules/<name>/`, then **wires the plugin and routes
into `src/app.ts` for you**. Models get `createdAt` + `updatedAt` automatically.
`--soft-delete` adds a `deletedAt` column (so `delete` marks the row instead of
removing it, and `list`/`find` skip soft-deleted rows), a `restore()` method,
and a `POST /projects/:id/restore` route.

The generated code is **secure by default**. Every route requires an
authenticated user (`meta: { auth: true }`), so the app refuses to boot until
an auth plugin enforces it and anonymous callers get 401. When the project
depends on `@basaltkit/tenancy`, the resource is **tenant-owned**: the
repository scopes every read and write with `requireTenantId()` (no tenant →
`TENANT_REQUIRED`, 400), and the Prisma model gets an indexed `tenantId`
column. The generated test signs in, checks that anonymous calls get 401 and,
for tenant-owned data, that one tenant cannot see another's rows. A short
security note after generation says which of these applies. Row-level
authorization (who may read or write which rows) is still up to you.

| Generator flag | Applies to | What it does |
| --- | --- | --- |
| `--prisma` | `make:resource`, `make:repository` | Prisma-backed repository plus a model appended to `schema.prisma` |
| `--soft-delete` | `make:resource` and the artifacts it builds | `deletedAt` column, `restore()`, restore route, filtered reads |
| `--dir=<path>` | all `make:*` | Target root (default: the current directory) |
| `--force` | all `make:*` | Overwrite existing files instead of refusing |
| `--no-register` | `make:resource` | Skip the automatic wiring into `src/app.ts` |
| `--public` | `make:resource`, `make:routes`, `make:test` | Routes without `meta.auth`, open to anonymous callers (alias `--no-auth`). Use only for a deliberately public resource |
| `--tenant` / `--no-tenant` | `make:resource`, `make:repository`, `make:test` | Force tenant scoping on or off (default: on when `package.json` depends on `@basaltkit/tenancy`) |
| `--crud` / `--no-crud` | `make:service` | Force the CRUD service or the minimal one (default: CRUD when the sibling repository and schema are already in the target directory) |

Individual artifacts are available as `make:schema`, `make:repository`,
`make:service`, `make:plugin`, `make:routes` and `make:test`.

### Services that are not CRUD

A CRUD service delegates to a sibling repository and imports the sibling
schema. Generated on its own, where those files do not exist, it would not
compile (`TS2307: Cannot find module './invoice.repository.js'`) — so
`make:service` looks at the target directory first:

- `<name>.repository.ts` **and** `<name>.schema.ts` already there (after
  `make:resource`, or written by you) → the CRUD service, as before;
- either one missing → a **minimal service**: the class, its `createToken`
  injection token and a constructor with no dependencies, importing nothing but
  `@basaltkit/core`. It compiles as written and carries a TODO pointing at
  `make:resource` for the CRUD vertical.

That is the shape for orchestration, domain rules, transactions, schedulers —
the services a repository has nothing to do with.

```bash
pnpm basalt make:service Billing            # minimal: no repository next to it
pnpm basalt make:service Invoice --crud     # force the CRUD shape
pnpm basalt make:service Invoice --no-crud  # force the minimal shape
```

`make:resource` is unaffected: the vertical always gets the CRUD service,
because it generates the repository and the schema in the same batch.

### One artifact at a time: the sibling warning

The service is the only artifact with a shape that stands on its own. The
others are members of a vertical and import one another — the plugin needs the
repository and the service, the routes need the service and the schema, the
test needs the plugin and the routes, the repository needs the schema.
Generating one of them alone still writes the file (the sibling may be the next
thing you write by hand), but the generator now names what it refers to and
cannot find:

```
Generated 1 file(s):
  src/modules/invoice/invoice.plugin.ts
Warning: src/modules/invoice/invoice.plugin.ts imports 2 file(s) that do not exist yet:
  src/modules/invoice/invoice.repository.ts
  src/modules/invoice/invoice.service.ts
  Generate the whole vertical with `basalt make:resource Invoice`, or write them yourself — until then this file does not compile.
```

`make:schema` never warns (it imports nothing of the module) and
`make:resource` never warns (it writes every one of them). Programmatically the
same list is `missingSiblings(kind, name, options, { baseDir })`, and
`expectedSiblings(kind, names(name))` is the static per-kind table.

What is true of the whole project — rather than of one invocation — is
configured where the commands are registered, including which Prisma client the
generated repositories are typed against:

```ts
commandsPlugin(
  generatorCommands({
    prisma: true,
    prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' },
  }),
)
```

An application with a second client (schema-per-tenant, a read replica) needs
that: against the default `PrismaClient` the generated repository either fails to
compile or, worse, compiles against the wrong models. Flags still win in both
directions — `--no-prisma` overrides `prisma: true`.

### Built-in CLI commands

`runCli` always offers these, alongside anything a plugin registers:

| Command | What it does |
| --- | --- |
| `list` (or no command) | Print every available command |
| `routes` | The registered HTTP routes, read from the `http:routes` metadata bucket |
| `schedule:list` | Scheduled tasks with their cron expressions and timezones |
| `dev` | Print the route table, then run the app with watch/restart. `--entry=<file>`, `--worker` (`-w`) to start a queue worker alongside, `--queue=<name>` |
| `upgrade` | Apply framework upgrade codemods. `--dry` to preview, `--only=<id>`, `--dir=<path>` |
| `publish` | Copy a stub group into the app (`dockerfile` — with a `.dockerignore` that keeps `.env` and keys out of the image —, `ci`, `editorconfig`). Run with no id to list; `--force` to overwrite |

Registering `queuePlugin` adds `queue:work`, `queue:stats`, `queue:retry` and
`queue:jobs` —
see [Queues & jobs](/guide/queues).

## Failure modes & troubleshooting

| Error | Exit code | When |
| --- | --- | --- |
| `TargetNotEmptyError` — "Target directory … already exists and is not empty" | 1 | The destination has files. Pick another name or `--dir=` |
| `Cancelled.` (`WizardCancelledError`) | 130 | Ctrl+C, or answering no to "Create project?". Nothing is written |
| `FileExistsError` — "Refusing to overwrite existing files" | 1 | A `make:*` target already exists. Re-run with `--force` |
| `Unknown command "…". Run "basalt list" to see what is available.` | 1 | Typo, or the plugin that registers the command isn't in `buildApp` |
| `No entry file found. Looked for src/main.ts, src/server.ts, …` | 1 | `basalt dev` in a project with a different entrypoint — pass `--entry=<file>` |

- **The scaffolder ignored my flags** — some package managers keep everything
  after the package name for themselves. Put the flags after `--`:
  `npm create basalt my-saas -- --billing --cli`. pnpm and bun forward them
  directly.
- **"Skipping dependency install (CI/non-interactive)"** — expected: without an
  explicit flag, only an interactive non-CI terminal installs. Pass `--install`
  (and `--git`) to force it.
- **`--ui` silently became pnpm** — it has to; the `web/` package is a pnpm
  workspace member. Start the frontend with
  `pnpm --filter <name>-web dev` (port 5180) while `pnpm dev` serves the API on
  3000.
- **"Could not auto-wire src/app.ts"** — `make:resource` only edits an
  `app.ts` that still uses `fastifyPlugin({ routes: [...] })`. Add the generated
  plugin to `plugins` and the routes to the adapter yourself; the generated
  files are otherwise complete.
- **The app connects to the wrong database / port** — a variable exported in
  your shell beats `--env-file`. Set the app-prefixed names (`MY_SAAS_PORT`)
  the scaffold declares, not the generic ones. See
  [`--env-file` never overrides exported variables](#env-file-never-overrides-exported-variables).
- **`pnpm basalt …` starts with a `pnpm install`** (or fails offline) — pnpm 11's
  `verifyDepsBeforeRun`. See
  [pnpm 11: release age and `verifyDepsBeforeRun`](#pnpm-11-release-age-and-verifydepsbeforerun).
- **`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, or `--experimental-strip-types`
  is rejected** — you're on a Node older than 22.5 / 22.6. Upgrade Node, or
  install `tsx` (which the scaffold already does).

## Where to next

- [Getting Started](/guide/getting-started) — the guided run through the
  generated app.
- [Configuration](/guide/config) — `src/env.ts`, secrets and the settings
  repository.
- [Core Concepts](/guide/concepts) — plugins, the container and request context.
- [Testing](/guide/testing) — `createTestApp` and the fakes shipped in
  `devDependencies`.
- [Production](/guide/production) — durable stores, Docker and the deploy
  checklist.
