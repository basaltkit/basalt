<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# create-basalt

Basalt project generator: a single command (`npm create basalt my-app`) creates a complete, ready-to-run SaaS application — typed API, authentication, multi-tenancy, and optionally billing, a web frontend, and the `basalt` CLI. It's the framework's starting point: use it whenever you want to start a new project.

## What this module solves

Starting a backend project from scratch involves dozens of decisions and files before you write the first useful line: setting up TypeScript, choosing the HTTP server, organizing folders, wiring up authentication, preparing tests… A **scaffolder** (project generator) does that work for you: it generates the initial structure with good practices already applied, so you can start building your product right away.

`create-basalt` generates a **SaaS** application (Software as a Service — software sold by subscription, usually with several customers/organizations in the same installation) shaped the way mature Basalt projects look in production: typed routes with Zod validation, structured logging, domain events, and, depending on the options, **multi-tenancy** (several isolated customers in the same application), authentication (register/login/refresh), subscriptions with plans, a React frontend, and the `basalt` command-line tool with code generators.

It works in two ways: interactive mode (answers questions in the terminal) or direct mode with flags (ideal for scripts). It doesn't install dependencies or touch git unless you ask it to (`--install`, `--git`).

## Installation

You don't need to install anything — your package manager's `create` command downloads and runs the package on the spot:

```bash
npm create basalt my-app
# or
pnpm create basalt my-app
# or
yarn create basalt my-app
# or
bun create basalt my-app
```

> Requirements: Node.js 22.5+ and a package manager. Projects with `--ui` require **pnpm** (explained below).

## Get started in 5 minutes

1. Create the project (interactive mode — run without a name and answer the questions):

```bash
npm create basalt
```

```
Project name: my-app
Multi-tenancy? (Y/n) y
Authentication? (Y/n) y
Subscriptions / billing? (y/N) n
Web UI (React + shadcn)? (y/N) n
MCP server (routes as AI-agent tools)? (y/N) n
'basalt' CLI (code generators)? (y/N) n
Database (PostgreSQL via Prisma)? (y/N) n
Install dependencies now? (y/N) y
Initialize a git repository? (y/N) y
```

2. Go into the folder and start it up:

```bash
cd my-app
npm install     # if you didn't choose to install in the previous step
npm run dev     # API at http://localhost:3000
```

3. Try it out:

```bash
curl http://localhost:3000/          # index listing the available endpoints
curl http://localhost:3000/health    # { ok: true, requestId: ..., tenant: null }
```

4. Run the included tests:

```bash
npm test
```

## Usage guide

### All CLI flags

```
Usage: npm create basalt <name> [options]
```

| Flag | Default | What it does |
| --- | --- | --- |
| `<name>` | — (asked in interactive mode) | Project name (and folder name, unless `--dir`) |
| `--dir=<path>` | `./<name>` | Destination folder |
| `--no-tenancy` | tenancy **on** | Removes multi-tenancy (`@basaltkit/tenancy`) |
| `--no-auth` | auth **on** | Removes authentication (`@basaltkit/auth`, `APP_SECRET`, `/auth/*` routes) |
| `--billing` | off | Includes subscriptions/plans (`@basaltkit/subscriptions`, example `free` and `pro` plans) |
| `--ui` | off | Generates the `web/` frontend (React + shadcn via `@basaltkit/admin-shadcn` + `@basaltkit/sdk`). **Forces pnpm** — see note below |
| `--cli` | off | Generates the `basalt` CLI (`bin/basalt.ts`, `pnpm basalt` script, `make:*` generators from `@basaltkit/generator`) |
| `--mcp` | off | Exposes read-only routes as MCP tools (`@basaltkit/mcp`) over HTTP at `POST /mcp` — the overview and health endpoints are opted in via `meta.mcp` |
| `--prisma` (alias `--db`) | off | Backs the app with PostgreSQL through Prisma: `prisma/schema.prisma`, `prisma.config.ts`, `src/db.ts`, the `@basaltkit/*-prisma` stores instead of the in-memory ones, a required `<APP>_DATABASE_URL`, the `db:*` scripts and `prismaPlugin({ assertMigrated: true })` — see *With `--prisma`* below |
| `--install` | off | Installs dependencies at the end (with the detected/chosen manager) |
| `--git` | off | Runs `git init` + first commit ("Initial commit from create-basalt") |
| `--offline` | off | Don't query the npm registry for the latest versions; use the ranges bundled with this create-basalt release |
| `--pm=<manager>` | autodetect | Package manager: `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Skips the questions and accepts the defaults |
| `-h`, `--help` | — | Shows help and exits |

Behavior notes (faithful to the code):

- **Package manager detection**: by default, detects who invoked the command via the `npm_config_user_agent` variable (set by npm/pnpm/yarn/bun); unknown managers fall back to `npm`. `--pm=` overrides this.
- **`--ui` forces pnpm**: the `web/` frontend is a member of a pnpm *workspace* (declared in the generated `pnpm-workspace.yaml`). npm, yarn, and bun can't install or run that structure, so if you request `--ui` with another manager, you'll see `Note: --ui projects are pnpm workspaces — using pnpm instead of <manager>.` and pnpm is used.
- **Interactive wizard**: when you don't pass a name, you're in a terminal (TTY), and you didn't use `--yes`, you get the guided wizard — an intro, a **starting-point preset** (SaaS starter / API only / Full stack / Minimal / Custom), an arrow-key **feature multiselect** on the custom path, package-manager select, and a **summary + confirm** step before anything is written. Ctrl+C (or declining the final confirm) ends cleanly with "Cancelled." (exit code 130).
- **Latest dependency versions**: before writing files, the CLI asks the npm registry (`npm_config_registry` when set by your package manager, else `registry.npmjs.org`) for the `latest` version of every dependency the project will contain and writes `^<latest>`. `@basaltkit/*` packages always take the latest release. Third-party packages (TypeScript, Vitest, React, Vite, Tailwind, …) take the latest only on the major the templates are written for — a newer major keeps the bundled range and prints a `Note:`. If the registry can't be reached (offline, timeout), the bundled ranges are used with one `Warning:` line; the scaffold never fails because of the registry. `--offline` skips the lookup entirely.
- **Release-age window (pnpm `minimumReleaseAge`)**: a third-party `latest` not provably older than the window (default 1440 min = pnpm 11's default; follows `pnpm_config_minimum_release_age` / `npm_config_minimum_release_age`) keeps the bundled range, so the first `pnpm install` is never blocked by a just-published version — pnpm then picks the newest *mature* version inside that range. The age comes from one `HEAD <registry>/<name>` per third-party package (the packument's `last-modified`, measured against the registry's `Date`); a missing header or failed probe counts as "not provably mature" and prints a `Note:`. `@basaltkit/*` is never probed (the generated `pnpm-workspace.yaml` excludes the scope).
- **Occupied folder**: if the destination folder exists and isn't empty, the command refuses with `Target directory "<dir>" already exists and is not empty.` and exits with code 1.
- At the end, it prints the created files and the "Next steps" appropriate to your choices.

### Invocation examples

```bash
# Interactive wizard (presets, feature multiselect, summary):
pnpm create basalt

# Full project, no questions, with everything:
pnpm create basalt my-app --billing --ui --cli --prisma --install --git

# Minimal API (no tenancy or auth), in another folder:
npm create basalt service-api --no-tenancy --no-auth --dir=./apps/service-api

# Accept all defaults with no questions:
npm create basalt my-app -y

# Force yarn as the manager:
npm create basalt my-app --pm=yarn --install
```

### What gets generated

Always:

```
my-app/
├── package.json          # scripts: dev, start, test, typecheck (+ basalt with --cli)
├── tsconfig.json         # strict TypeScript, ESM
├── .env.example          # MY_APP_PORT, MY_APP_HOST, MY_APP_LOG_LEVEL, NODE_ENV (+ MY_APP_APP_SECRET with auth) + the --env-file precedence warning
├── .gitignore
├── README.md             # instructions adapted to the chosen options
├── pnpm-workspace.yaml   # esbuild allowBuilds, @basaltkit/* release-age exclusion (+ "web" member with --ui) + pnpm 11 notes
├── src/
│   ├── env.ts            # environment variables validated with Zod (@basaltkit/env), app-prefixed
│   ├── app.ts            # buildApp() with the chosen plugins
│   ├── routes.ts         # GET / (friendly index) and GET /health
│   └── server.ts         # startup + clean shutdown on SIGINT/SIGTERM
└── tests/app.test.ts     # smoke test adapted to the options
```

With `--prisma`, adds `prisma/schema.prisma`, `prisma.config.ts`, `src/db.ts`, `prisma/seed.ts` (with tenancy) and the `db:generate` / `db:migrate` / `db:deploy` / `db:seed` scripts. With `--cli`, adds `bin/basalt.ts` and the `"basalt": "tsx bin/basalt.ts"` script. With `--ui`, adds the `web/` folder (Vite 8 + React 19 + Tailwind CSS 4 via `@tailwindcss/vite` + shadcn — Tailwind is configured in `web/src/index.css`, no `tailwind.config.js`/PostCSS — with `web/src/api.ts` built on top of `@basaltkit/sdk`; with auth on it includes a login/register screen).

### With `--ui`: running the API and frontend

```bash
pnpm install
pnpm dev                              # terminal 1 — API on :3000
pnpm --filter my-app-web dev       # terminal 2 — UI at http://localhost:5180
```

Vite's dev server proxies `/api` to the API — there's no CORS to configure.

### With `--prisma`: a PostgreSQL-backed app

Without the flag the generated app has **no database**: it boots on
`MemoryUserSource` / `MemoryTenantSource` and the default in-memory team and
subscription stores, which is ideal for a first run and for CI and is gone on
the next restart.

`--prisma` (or `--db`) generates the database-backed shape instead:

| File | What it holds |
| --- | --- |
| `prisma/schema.prisma` | The reference models of every `@basaltkit/*-prisma` package the project uses — the same blocks `basalt prisma:sync` merges — plus a `Project` model of your own |
| `prisma.config.ts` | Prisma 7 keeps the connection URL here. It reads `MY_APP_DATABASE_URL` first and the bare `DATABASE_URL` only as a fallback — the same precedence as `src/env.ts`, so the CLI and the app can never mean two different databases |
| `src/db.ts` | `prisma` (unscoped — the framework stores use it, they run before a tenant is known) and, with tenancy, `db = prisma.$extends(tenancyExtension())` |
| `src/app.ts` | `prismaPlugin({ client: db, assertMigrated: true })`, `prismaTenantSource`, `prismaAuthStores`, `prismaTeamsStores`, `prismaSubscriptionsStores` |
| `prisma/seed.ts` | The `demo` tenant the header and subdomain resolvers expect |

```bash
pnpm create basalt my-app --prisma
cd my-app && pnpm install     # postinstall runs `prisma generate`
cp .env.example .env          # point MY_APP_DATABASE_URL at your database
pnpm db:migrate               # prisma migrate dev — creates the tables and seeds `demo`
pnpm dev
```

**Migrations, never `prisma db push`.** The generated app boots with
`assertMigrated: true`, which refuses to start unless the database it reached has
the `_prisma_migrations` table — written by `prisma migrate dev` /
`prisma migrate deploy`, and *not* by `db push`. That is what turns a wrong
`DATABASE_URL` (a shell that exported another project's) into a boot error naming
the database and host instead of a `500` on the first request. In production:
`pnpm db:deploy`.

The generated `tests/app.test.ts` skips itself when no database is configured, so
`pnpm test` stays green on a machine without PostgreSQL. To add another Basalt
domain later, install its `@basaltkit/<domain>-prisma` package, run
`pnpm basalt prisma:sync` (with `--cli`) and then `pnpm db:migrate`.

### With `--cli`: the `basalt` command line

```bash
pnpm basalt list                    # available commands
pnpm basalt routes                  # registered HTTP routes
pnpm basalt make:resource Project   # generates schema → repository → service → plugin → routes → test
```

With pnpm 11, every `pnpm <script>` and `pnpm exec` first verifies dependencies (`verifyDepsBeforeRun`, default `install`) and runs `pnpm install` when any workspace project is out of sync — so `pnpm basalt …` can need the network. `node_modules/.bin/tsx bin/basalt.ts …` skips that check; `verifyDepsBeforeRun: warn` (commented out in the generated `pnpm-workspace.yaml`) turns it into a warning for the whole project.

### `pnpm-workspace.yaml` and pnpm 11

- `minimumReleaseAgeExclude` is evaluated **first-match-wins by package name**. To exclude several versions of one package, write ONE entry with a union — `'@types/node@22.20.4 || 26.6.2'` — never two `@types/node@…` entries (only the first would apply). The generated file carries this example as a comment.
- `verifyDepsBeforeRun: warn` is offered commented out; the scaffold keeps pnpm's secure default (`install`).

### Environment variables and `--env-file`

Nothing loads `.env` for you. `node --env-file=.env` / `tsx --env-file=.env` **never override a variable already exported in the shell** — in a terminal where another project exported `DATABASE_URL` or `PORT`, an app reading the generic name boots against that value and only fails on the first request that touches it.

The scaffold closes that trap instead of only warning about it: `src/env.ts` passes an **app-specific prefix** derived from the project name (`my-saas` → `MY_SAAS`) to `defineEnv`, and `.env.example` uses the prefixed names.

```ts
// src/env.ts (generated)
export const env = defineEnv(
  { PORT: z.coerce.number().default(3000), /* … */ },
  { prefix: 'MY_SAAS' },
)
```

```bash
# .env.example (generated)
MY_SAAS_PORT=3000
MY_SAAS_HOST=0.0.0.0
MY_SAAS_LOG_LEVEL=info
NODE_ENV=development          # never prefixed — a Node-wide convention
# MY_SAAS_APP_SECRET=         # with auth
```

Each variable is read as `MY_SAAS_<NAME>` first and **falls back** to the bare `<NAME>`, so a deployment that already exports the generic names keeps booting — while a stray `PORT` in your shell no longer wins. The rest of the app is unchanged: the keys stay bare (`env.PORT`). To require the prefixed names only, edit the generated file to `prefix: { value: 'MY_SAAS', fallback: false }`. Full rules: [`@basaltkit/env`](https://github.com/basaltkit/basalt/tree/main/packages/env#app-specific-prefix-prefix).

### Programmatic usage (Advanced)

The package also exports the API used by the executable, for your own scripts:

```typescript
import { createProject, detectPackageManager, TargetNotEmptyError } from 'create-basalt'

const result = await createProject({
  name: 'my-app',
  dir: './output/my-app', // optional; default: ./<name>
  tenancy: true,
  auth: true,
  billing: false,
  ui: false,
  cli: true,
})
console.log(result.dir)     // absolute path created
console.log(result.files)   // relative paths, sorted
console.log(detectPackageManager()) // 'pnpm' | 'npm' | 'yarn' | 'bun'
```

Note: `createProject` **only writes files** — it doesn't install dependencies or initialize git (that's the executable's job, with `--install`/`--git`). It also uses the bundled dependency ranges unless you pass `resolveLatest: true` (what the executable does), so a script never touches the network by surprise.

## API reference

Exported from `create-basalt` (in addition to the `create-basalt` executable):

### `createProject(input): Promise<CreateProjectResult>`

`CreateProjectInput`:

| Field | Type | Required? | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | Yes | — | Project name |
| `dir` | `string` | No | `./<name>` (relative to cwd) | Destination folder |
| `tenancy` | `boolean` | No | `true` | Include multi-tenancy |
| `auth` | `boolean` | No | `true` | Include authentication |
| `billing` | `boolean` | No | `false` | Include subscriptions |
| `ui` | `boolean` | No | `false` | Generate the `web/` frontend |
| `cli` | `boolean` | No | `false` | Generate the `basalt` CLI |
| `mcp` | `boolean` | No | `false` | Expose read-only routes as MCP tools at `/mcp` |
| `prisma` | `boolean` | No | `false` | Back the app with PostgreSQL through Prisma (schema, migrations, Prisma-backed stores, `assertMigrated`) |
| `resolveLatest` | `boolean` | No | `false` | Resolve every dependency to `^<latest>` from the npm registry before writing (falls back to the bundled ranges on any registry failure) |
| `registry` | `ResolveLatestOptions` | No | — | `{ fetch?, registry?, timeoutMs?, overallTimeoutMs?, concurrency?, minimumReleaseAge?, now? }` — injectable fetch (tests), registry URL (default `npm_config_registry` or `https://registry.npmjs.org`), timeouts (5 s per request, 15 s overall), release-age window in minutes (default `pnpm_config_minimum_release_age` / `npm_config_minimum_release_age`, else 1440; `0` disables the probe), clock (tests) |

`CreateProjectResult`:

| Field | Type | Description |
| --- | --- | --- |
| `dir` | `string` | Absolute path of the created folder |
| `files` | `string[]` | Files written (relative, sorted) |
| `options` | `ProjectOptions` | The options actually applied (with defaults resolved) |
| `versions` | `VersionResolution \| undefined` | With `resolveLatest`: `{ versions, resolved, failed, heldBack, tooFresh, registry }` — the final ranges, which packages got `^<latest>`, which kept the fallback after a registry failure, third-party packages held back because their latest is a new major, and third-party packages whose latest is not provably older than the release-age window (`{ name, latest, range, reason: 'recent' \| 'unknown' }`) |

Throws `TargetNotEmptyError` if the destination folder exists and isn't empty.

### `detectPackageManager(userAgent?): PackageManager`

Detects the manager that invoked the command from `npm_config_user_agent` (or the string passed in). Returns `'pnpm' | 'yarn' | 'bun'` when recognized; otherwise `'npm'`.

### `TargetNotEmptyError`

Error (extends `Error`) with the message `Target directory "<dir>" already exists and is not empty.`

### Exported types

| Type | Description |
| --- | --- |
| `PackageManager` | `'pnpm' \| 'npm' \| 'yarn' \| 'bun'` |
| `ProjectOptions` | `{ name, tenancy, auth, billing, ui, cli, mcp, prisma }` — all resolved (no optionals) |
| `CreateProjectInput`, `CreateProjectResult` | Described above |

## Common errors and solutions (FAQ)

**I created a project with `--ui` and `npm install` fails (`web/` dependencies don't resolve).**
This is the classic error: the `web/` frontend is a member of a **pnpm** *workspace* (`pnpm-workspace.yaml`). npm (like yarn and bun) doesn't read that file, so it doesn't install `web/`'s dependencies or manage to launch its dev server. Solution: use pnpm in that project — `pnpm install` at the root and `pnpm --filter <name>-web dev` for the UI. (This is why the CLI itself switches to pnpm when you request `--ui` with another manager.)

**`Target directory "…" already exists and is not empty.`**
The destination folder already has content. Choose another name, point to another folder with `--dir=`, or empty it first. The generator never overwrites anything.

**I ran the command in a script/CI and it hung or didn't ask anything.**
Outside an interactive terminal (no TTY) the questions are skipped. Always pass the name and flags explicitly — and use `-y` to make sure no prompt appears.

**`(skipped — git unavailable or already a repo)` after `--git`.**
`git init`/commit failed — either git isn't installed, or the folder already belongs to a repository. The project is still created; handle git by hand.

**`(install failed — run "pnpm install" yourself)`.**
Automatic installation failed (network, Node version, etc.). Go into the folder and run `pnpm install` (or the indicated manager) to see the real error.

**I started the app and `GET /auth/login` gives a secret error.**
With auth on, `src/env.ts` requires `APP_SECRET` — read as `MY_SAAS_APP_SECRET`, with at least 32 characters (`secret()` supplies a development default only when `NODE_ENV` is explicitly `development`/`test`). Copy `.env.example` to `.env` and set your own secret before going to production.

**With `--prisma`, the app refuses to boot: `PRISMA_NOT_MIGRATED`.**
`assertMigrated` reached a database without the `_prisma_migrations` table. The
message names the database and host it actually reached (never the
credentials): either it is not the database you meant — check
`env | grep DATABASE_URL`, a shell may have exported another project's — or it
was never migrated: run `pnpm db:migrate` (development) or `pnpm db:deploy`
(production). A database set up with `prisma db push` has no
`_prisma_migrations` at all; this scaffold is migration-based on purpose.

**With `--prisma`, `pnpm typecheck` can't find `./generated/prisma/client.js`.**
The Prisma client is generated code, not a checked-in file. `pnpm install` runs
`prisma generate` for you (`postinstall`); after a `git clone` without install,
or after editing the schema, run `pnpm db:generate`.

**My app connects to the wrong database / port.**
A variable exported in your shell beats `--env-file`. The generated `src/env.ts` already reads app-prefixed names (`MY_SAAS_PORT`), so set those rather than the generic ones — the bare names are only a fallback. Check `env | grep DATABASE_URL`, and see *Environment variables and `--env-file`*.

**`pnpm basalt …` starts by running `pnpm install` (or fails offline).**
pnpm 11's `verifyDepsBeforeRun` (default `install`). Run `node_modules/.bin/tsx bin/basalt.ts …` instead, or set `verifyDepsBeforeRun: warn` in `pnpm-workspace.yaml`.

**I want to change my mind after generating (e.g. add billing).**
There's no "re-scaffold" command. Either generate a new project with the right flags and compare, or add it by hand: install `@basaltkit/subscriptions` and add the `subscriptionsPlugin` to `src/app.ts` (the generated README and the templates serve as reference).

## How it connects to other modules

`create-basalt` isn't used *by* the application — it writes the application that uses the other packages:

- **`@basaltkit/core`, `@basaltkit/config`, `@basaltkit/env`, `@basaltkit/events`, `@basaltkit/fastify`, `@basaltkit/logger`** — the foundation of any generated project (`createApp` + plugins in `src/app.ts`).
- **`@basaltkit/tenancy`** — included by default (remove with `--no-tenancy`): header and subdomain resolvers, with a demo `MemoryTenantSource`.
- **`@basaltkit/auth`** — included by default (remove with `--no-auth`): `/auth/*` routes and `APP_SECRET` validated in `env.ts`.
- **`@basaltkit/subscriptions`** — with `--billing`: example `free`/`pro` plans with trial and feature limits.
- **`@basaltkit/prisma` + `@basaltkit/{tenancy,auth,teams,subscriptions}-prisma`** — with `--prisma`: the PostgreSQL layer — `prismaPlugin` (tenant-scoped client, boot-time `assertMigrated`), the composed `prisma/schema.prisma` and the Prisma-backed stores for whichever domains are on.
- **`@basaltkit/cli` + `@basaltkit/generator`** — with `--cli`: `bin/basalt.ts` calls `runCli`, and `commandsPlugin(generatorCommands())` registers the `make:*` generators.
- **`@basaltkit/sdk` + `@basaltkit/admin-shadcn` + `@basaltkit/admin`** — with `--ui`: the `web/` frontend calls the API through a typed client and uses the shadcn components.
- **`@basaltkit/testing`** — always present in `devDependencies`, with a generated smoke test in `tests/app.test.ts`.
