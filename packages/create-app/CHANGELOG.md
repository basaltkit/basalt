# create-basalt

## 1.8.0

### Minor Changes

- 6d446ef: Add `--prisma` (alias `--db`): scaffold a PostgreSQL-backed app instead of a memory-only one.
  
  Until now every generated app booted on in-memory sources, so `prismaPlugin({ assertMigrated: true })` — the boot-time check that catches an app pointed at an unmigrated or simply *wrong* database — had nothing to guard. `--prisma` generates the database-backed shape:
  
  - `prisma/schema.prisma` composed from the reference models of every `@basaltkit/*-prisma` package the project uses (the same blocks `basalt prisma:sync` merges) plus an app-owned `Project` model, and `prisma.config.ts` carrying the connection URL (Prisma 7).
  - `src/db.ts` with the unscoped `prisma` client for the framework stores and, with tenancy, `db = prisma.$extends(tenancyExtension())`.
  - `src/app.ts` wiring `prismaPlugin({ client: db, assertMigrated: true })`, `prismaTenantSource`, `prismaAuthStores`, `prismaTeamsStores` and `prismaSubscriptionsStores` in place of the memory ones, plus a `prisma/seed.ts` for the `demo` tenant.
  - `<APP>_DATABASE_URL` as a required variable (same prefixed-first precedence in `src/env.ts` and `prisma.config.ts`), `.env.example` updated, and `db:generate` / `db:migrate` / `db:deploy` / `db:seed` scripts — migrations only, because `prisma db push` writes no `_prisma_migrations` table for `assertMigrated` to find.
  
  Without the flag the scaffold is unchanged: no database, no Prisma dependency, the same memory sources as before.

## 1.7.0

### Minor Changes

- 7363b76: App-specific env prefixes (BK-018, the half PR #368 left open).
  
  `node --env-file=.env` never overrides a variable already exported in the shell, so an app reading generic names (`DATABASE_URL`, `PORT`) silently boots against another project's database and only fails on the first request. #368 documented the trap; this closes it.
  
  - `@basaltkit/env`: `defineEnv(shape, { prefix })` reads every variable as `<PREFIX>_<NAME>` first — `prefix: 'MY_SAAS'` makes `DATABASE_URL` come from `MY_SAAS_DATABASE_URL`, falling back to the bare `DATABASE_URL`. The fallback is explicit and configurable: `prefix: { value: 'MY_SAAS', fallback: false }` requires the prefixed names and ignores the bare ones. The shape's keys never change (`env.PORT`), the prefixed name wins whenever it is *set* (an empty value counts as set, as in `process.env`), and `NODE_ENV` is never prefixed — it is a Node-wide convention read by the whole toolchain and by `secret()`.
  - Error reports name the key the app actually looked for: `MY_SAAS_DATABASE_URL (or DATABASE_URL): Required` when neither name is set, `MY_SAAS_PORT: …` (or `PORT: …`) for an invalid value, depending on where it came from. With `fallback: false` only the prefixed name is named.
  - New `EnvPrefixError` (`ENV_PREFIX_INVALID`): a prefix must itself be a valid variable name — uppercase letters, digits and single inner underscores, starting with a letter and not ending in `_`. `my-saas` or `1APP` fails at boot instead of looking up a variable nobody can set.
  - Without `prefix`, `defineEnv` is byte-for-byte the old behaviour: the source object is parsed as-is, reports use the shape keys, and an unset `NODE_ENV` still counts as production for `secret()`.
  - `create-basalt`: a scaffolded app now wires this. `src/env.ts` passes `prefix: '<PROJECT_NAME>'` (`my-saas` → `MY_SAAS`), and `.env.example` plus the generated README use the prefixed names (`MY_SAAS_PORT`, `MY_SAAS_HOST`, `MY_SAAS_LOG_LEVEL`, `MY_SAAS_APP_SECRET`, and `MY_SAAS_DATABASE_URL` for when a database is added). `NODE_ENV` stays unprefixed. The documented bare-name fallback means an existing deployment exporting the generic names keeps booting.

## 1.6.0

### Minor Changes

- b0cc59f: pnpm 11 robustness and env-precedence guidance for scaffolded apps (BK-002, BK-018).
  
  - Release-age aware version resolution: a third-party `latest` that is not provably older than pnpm's `minimumReleaseAge` window (default 1440 min, pnpm 11's default; follows `pnpm_config_minimum_release_age` / `npm_config_minimum_release_age`) keeps the bundled range instead of `^<latest>`, so the first `pnpm install` is never blocked by a just-published version. The age comes from one cheap `HEAD <registry>/<name>` per third-party package (`last-modified`, measured against the registry's `Date`); `@basaltkit/*` is never probed. New `ResolveLatestOptions.minimumReleaseAge` (`0` disables) and `now`, new `VersionResolution.tooFresh`, and exported `minimumReleaseAgeMinutes()` / `DEFAULT_MINIMUM_RELEASE_AGE_MINUTES` / `FreshVersion`.
  - The generated `pnpm-workspace.yaml` documents that `minimumReleaseAgeExclude` is first-match-wins by package name (per-version exclusions of one package must be a single `'name@a || b'` union entry) and offers `verifyDepsBeforeRun: warn` as a commented, conscious opt-in.
  - The generated README explains that with pnpm 11 `pnpm basalt …` may run `pnpm install` first and how to call the CLI directly (`node_modules/.bin/tsx bin/basalt.ts`).
  - The generated `.env.example` and README warn that `--env-file` never overrides variables already exported in the shell and suggest an app-specific prefix derived from the project name (e.g. `MY_SAAS_DATABASE_URL`).

## 1.5.0

### Minor Changes

- 34c3641: New projects now get the latest published version of every dependency. Before writing files, the CLI asks the npm registry (`npm_config_registry`, else `registry.npmjs.org`) for each package's `latest` and writes `^<latest>` into the root and `web/` package.json. `@basaltkit/*` packages always take the latest release; third-party packages take it only on the major the templates are written for (a newer major keeps the bundled range and prints a notice). If the registry is unreachable or slow, the ranges bundled at build time are used with a single warning, and the scaffold never fails because of the registry. `--offline` skips the lookup. Programmatically, `createProject({ resolveLatest: true, registry: { fetch, registry } })` opts in; the default still touches no network.
  
  The templates move to current majors: TypeScript 7, Vitest 5, `@types/node` 26, React 19, Vite 8 with `@vitejs/plugin-react` 6, and Tailwind CSS 4. The UI now loads Tailwind through `@tailwindcss/vite`, keeps its config in `web/src/index.css` (`@import 'tailwindcss'`, `@source` for `@basaltkit/admin-shadcn`, `@theme inline` for the shadcn tokens, a class-based `dark` variant), and no longer emits `tailwind.config.js`, `postcss.config.js`, `postcss` or `autoprefixer`. `web/tsconfig.json` adds `vite/client` types, so `import './index.css'` typechecks under TypeScript 6+, and `web/` gets a `typecheck` script.
- fb85c40: Security (scaffold & dev tooling hardening):
  
  - `create-basalt`: with tenancy + auth (the default), new apps now depend on `@basaltkit/teams` and register `teamsPlugin()` + `tenantMembershipPlugin()`, so an authenticated user can no longer act on a tenant they do not belong to by changing `x-tenant-id`/`Host` (a dev-only seed adds registrants to the `demo` tenant). The `securityPlugin` global per-IP rate limit is now enabled, not commented out. `pnpm dev` runs a new `src/dev.ts` that opts into `NODE_ENV=development`; `pnpm start` does not, and the app's `NODE_ENV` now defaults to `production`. `@basaltkit/*` dependency ranges are generated from each package's current release line instead of a frozen `^1.0.0`. A `.dockerignore` is scaffolded.
  - `@basaltkit/env`: `secret()` applies `devDefault`, and accepts placeholder-looking values, only when `NODE_ENV` is explicitly `development` or `test`. An unset `NODE_ENV` (or any other value) now counts as production, so a deploy that forgets `NODE_ENV` can no longer boot on the public dev default. Set `NODE_ENV=development` locally (the scaffold's `pnpm dev` does this).
  - `@basaltkit/ai`: the `missing-tenant-membership` doctor rule now fires for tenancy + auth even when `@basaltkit/teams` is not installed (recommending installing it). Plans are validated before code generation: field and relation names must be plain identifiers, entity and audit-event names are restricted, and enum values are emitted as escaped string literals, so a crafted plan cannot inject code into generated sources (`assertSafePlan` / `UnsafePlanError`).
  - `@basaltkit/ai-mcp`: `basalt_make` validates the client-supplied plan against `ArchitecturePlanSchema` instead of casting it, and rejects invalid plans.
  - `@basaltkit/cli`: `basalt publish dockerfile` also writes a `.dockerignore`, so `COPY . .` can no longer bake `.env` or private keys into image layers.

## 1.4.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

## 1.4.1

### Patch Changes

- 8a3e92a: Scaffolded apps now pass `pnpm typecheck` out of the box.
  
  The templates emitted `LOG_LEVEL: z.string()` in `env.ts` and `logLevel?: string` in `BuildAppOptions` — both feeding `loggerPlugin({ level })`, which takes the `LogLevel` union — so a pristine scaffold's own `typecheck` script failed with TS2322. The templates now emit `z.enum(LOG_LEVELS)` and `logLevel?: LogLevel`. A new CI net scaffolds two app variants (default, and billing+cli+mcp) and compiles them with the real workspace packages, so template ↔ package type drift fails in this repo's CI instead of in a user's first typecheck.

## 1.4.0

### Minor Changes

- edb7eef: Interactive scaffolds now install dependencies and initialize git by default.
  
  `npm create basalt my-app` in a terminal ends in a runnable app: dependencies are installed (with the detected package manager) and a git repository is initialized, so the "Next steps" shrink to `cd` + `run dev`. The wizard's install/git prompts default to yes.
  
  CI and non-TTY runs are never surprised: with no explicit flag, install/git are skipped there with a clear message (`--install` / `--git` force them). New `--no-install` / `--no-git` flags opt out anywhere; explicit flags always win over the environment. New export: `resolveRunDefaults` (the pure policy, unit-tested).

## 1.3.0

### Minor Changes

- 552cbe8: AI MCP bridge — M4 (prompts + polish), RFC 0001 §E. The dev-only bridge is now feature-complete per the RFC.
  
  - **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains:
    - **Workflow prompts** (`prompts/list` + `prompts/get`): `plan-feature`, `scaffold-resource`, `harden-tenancy`, `add-rbac`. Each encodes the safe loop (analyze → plan → make **preview** → review → make apply), references the real tools/resources by name, and substitutes its arguments. The `prompts` capability is advertised.
    - **Optional HTTP transport** — an opt-in `--http[=port]` flag on the `basalt-ai-mcp` bin (and `createAiMcpHttpServer`), for remote/CI. stdio stays the default local-dev transport.
    - A **dev-only CI guard** test (RFC §D.4) asserting no workspace package lists `@basaltkit/ai` or `@basaltkit/ai-mcp` as a runtime/peer dependency.
  - **`@basaltkit/mcp-core`** adds a minimal, dependency-free **`serveHttp`** transport (pure `node:http`, no `@basaltkit/http`) — request/response JSON-RPC over `POST /mcp`. Shared by the runtime and dev servers without dragging the framework runtime into either graph.
  - **`create-basalt`** makes a `--mcp` app MCP-dev-ready: `@basaltkit/ai-mcp` is added as a **devDependency** (never a runtime dependency), a project-root `.mcp.json` registers the `basalt-ai-mcp` bridge for Claude Code/Desktop (`--cwd=.`), and the README documents the AI dev tools.

## 1.2.1

### Patch Changes

- 99b0e47: Make `basalt dev` worth using over a bare `tsx watch`.

  - **Route table on boot** — `basalt dev` now prints the app's registered HTTP routes (method, url, and an auth/rate-limit/tags flags column) before starting the server. The app is already booted by the CLI runner, so this is adapter-agnostic (reads the `http:routes` metadata). New pure `devRouteRows(routes)` (exported, tested).
  - **`--worker`** — also starts a watched `queue:work` process alongside the server, so jobs process in dev without a second terminal (the real producer/worker topology; each restarts independently). `--queue=<name>` scopes it.
  - **`--no-routes`** skips the table. Server watching still delegates to `tsx watch` / `node --watch`.

  create-basalt: the generated `bin/basalt.ts` help now mentions `basalt dev`.

## 1.2.0

### Minor Changes

- de28084: Add a rich interactive wizard.

  Running `create-basalt` with no name in a terminal now launches a guided, dependency-free wizard: an intro banner, a **starting-point preset** (SaaS starter / API only / Full stack / Minimal / Custom), an arrow-key **feature multiselect** on the custom path, a package-manager select (with the Web-UI-forces-pnpm rule), and a **summary + confirm** step before scaffolding. Passing a name, `--yes`, or piping input (CI) keeps the flag-driven path unchanged.

  Exposes the testable core: `runWizard(prompter, options)`, `validateProjectName`, `PRESETS`/`FEATURES`, and the `Prompter` abstraction with `ttyPrompter()` (raw-mode arrow keys) and `scriptedPrompter()` (tests).

## 1.1.1

### Minor Changes

- Scaffold ships `securityPlugin()` by default (secure headers) and a fail-closed `APP_SECRET` via `secret({ minLength: 32 })` (no committed default).

## 1.1.0

### Minor Changes

- Scaffolded apps now keep the code-generation layer **dev-only**. `--cli` projects register `make:*`/`prisma:sync` from `bin/basalt.ts` (which passes them via a new `buildApp({ commands })` option) instead of from `app.ts`, so the runtime server never imports `@basaltkit/generator` — it moves to devDependencies. A generated SaaS runs completely without the codegen/AI layer, while the `basalt` CLI keeps every command. (Add `@basaltkit/ai` in bin/basalt.ts for `ai:*`.)

## 1.0.1

### Patch Changes

- Register `basalt prisma:sync` in `--cli` apps out of the box. The generated CLI now
  adds `@basaltkit/prisma` and wires `prismaSyncCommand()` into `commandsPlugin`, so a
  fresh project can run `pnpm basalt prisma:sync --push` to merge every installed
  `@basaltkit/*-prisma` model into its `prisma/schema.prisma` — no hand-copying.
- Generated `pnpm-workspace.yaml` now excludes the `@basaltkit/*` scope from pnpm's
  `minimumReleaseAge` policy, so `pnpm up` is never blocked on a fresh Basalt release.

## 1.0.0

### Major Changes

- Generate 1.0 apps and ship ready-made auth flows. The @basaltkit/\* dependency
  range is now `^1.0.0` (was `^0.4.0`/`^0.1.0`, which pinned very old packages).
  With `--auth`, the backend wires `mfaRoutes()` alongside `authRoutes()`, and the
  `--ui` frontend now ships the full standard flows out of the box: sign in with a
  TOTP challenge, register, forgot-password, reset-password (via the emailed
  `?token` link), and a dashboard that manages two-factor (enroll → secret/otpauth
  → activate → recovery codes → disable).

## 0.5.2

### Patch Changes

- 4926a63: Exit cleanly on Ctrl+C during the interactive prompts. Previously aborting a
  prompt dumped a raw Node `AbortError` stack trace; now it prints "Cancelled."
  and exits with code 130.

## 0.5.0

### Minor Changes

- Generated apps now pin `@basaltkit/generator` at `^0.2.0` so they pick up the `make:resource` auto-wiring (in semver 0.x, `^0.1.0` locks the minor). Added a per-package version override map (`versionOf`) for @basalt deps that cross a minor.

## 0.4.0

### Minor Changes

- New `--cli` flag scaffolds the `basalt` CLI entrypoint (`bin/basalt.ts`) and wires `@basaltkit/cli` + `@basaltkit/generator`, so a freshly-created app can run code generators and built-in commands out of the box: `pnpm basalt make:resource Project` (full schema→repository→service→plugin→routes→test vertical), individual `make:*` generators, plus `basalt routes` and `basalt schedule:list`. The generated `app.ts` registers `commandsPlugin(generatorCommands())` and a `basalt` npm script is added.

## 0.3.0

### Minor Changes

- New `--ui` flag scaffolds a `web/` frontend: React + authentic shadcn/ui components (`@basaltkit/admin-shadcn`) talking to the API through the type-safe `@basaltkit/sdk`, with a Vite dev server that proxies `/api` to the backend (no CORS). With auth on it ships a login/register gate and a small dashboard; otherwise a live status page. `web` is wired as a pnpm workspace member so its dependencies resolve.

## 0.2.0

### Minor Changes

- Generated apps now include a friendly `GET /` index route that lists the API's endpoints, so a fresh app no longer answers the root path with a bare 404. The generated smoke test covers it.
- The CLI became a real create-tool: interactive prompts when run without a name in a terminal, `--install` to install dependencies, `--git` to initialize a repository with a first commit, `--pm=<pnpm|npm|yarn|bun>` plus auto-detection via `npm_config_user_agent`, and `-y/--yes` to accept defaults. Next-steps output is tailored to the detected package manager.
- New exported helper `detectPackageManager()`.

## 0.1.1

### Patch Changes

- Fix generated apps depending on @basaltkit/\* at the ^0.0.0 placeholder; now ^0.1.0 (the published range).

## 0.1.0

- Initial release.
