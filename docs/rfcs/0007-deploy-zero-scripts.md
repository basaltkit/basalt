# RFC 0007 — `basalt-deploy` phase 3: zero scripts, a typed config, `init`

- **Status:** Accepted (2026-10-12) — not yet implemented
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-12
- **Affects:** `@basaltkit/deploy` (config types, new commands `init` and `bootstrap`, declarative infra and verify, the `caddy` target); `create-basalt` (a new app ships a `deploy.config.ts`); no runtime package
- **Builds on:** RFC 0006 (the pipeline, the checks, the targets, phases 1–2 as built)
- **Non-negotiables honoured:** no HTTP surface; nothing runs inside the booted app; secrets never on a command line, in a log or outside a `0600` file; fail-closed

---

## 0. TL;DR

After phase 2, Mukanda deploys with the package, but it still carries **793
lines of shell** next to its `deploy.config.ts`: `infra.sh` (97), `migrate.sh`
(16), `verify.sh` (33) and `provision.sh` (632). LexFirma carries `deploy.sh`
(254). Almost all of it is generic: a least-privilege database role, buckets
with versioning and expiry, containers attached to the compose networks, a
one-off job before the release, error patterns in a worker's logs, and the
packages a fresh Ubuntu needs. The next app would write all of it again.

Phase 3 moves each of those into the config, as typed data:

1. **A config you fill in with autocomplete** (§2): every field documented on
   hover, every choice a literal union, and the `.env` keys typed from the
   app's own `src/env.ts`. A misspelt key is a red underline, not a failed
   deploy.
2. **`basalt-deploy init`** (§3) writes the `deploy.config.ts` from what is in
   the project and on the server; `create-basalt` ships one in every new app.
3. **Declarative infra and verify** (§4–§6): what `infra.sh`, `migrate.sh` and
   `verify.sh` do, as options.
4. **`basalt-deploy bootstrap` and the `caddy` target** (§7–§8): what
   `provision.sh` does.

The target: a new Basalt app deploys with **no `.sh` file**. Hooks (RFC 0006
§13.3) stay, as the escape hatch for what is truly one app's, not as the place
where every app re-implements the same things.

## 1. Inventory: what the scripts do today

| Script | Lines | Does | Generic? | Becomes |
|---|---:|---|---|---|
| Mukanda `infra.sh` | 97 | creates `mukanda_app` (no DDL) and its grants | yes | `postgres.appRole` (§4.1) |
| | | connects `mukanda-postgres`, `-redis`, `minio` to the compose networks | yes | `compose({ attach })` (§4.3) |
| | | buckets; versioning on one; 1-day expiry on another, added once | yes | `minio.buckets: [{ name, versioned, expireDays }]` (§4.2) |
| | | ClamAV signatures into a volume before clamd first starts | the mechanism | `compose({ jobs })` (§4.4) |
| Mukanda `migrate.sh` | 16 | `db:generate` + `db.ts deploy` + `db.ts status` | already | `migrate.command: ['pnpm', 'db:deploy']`, a `package.json` script (§5) |
| Mukanda `verify.sh` | 33 | no `EAI_AGAIN`/`ECONNREFUSED` in the ingest worker's logs | yes | `verify.logs` (§6) |
| | | the API image carries the company migrations | no | the app's `/readyz` (§6) |
| Mukanda `provision.sh` | 632 | Docker, Node, pnpm, swap, ufw | yes | `basalt-deploy bootstrap` (§7) |
| | | `api.env` with generated secrets | already | `env.generate` / `env.ask` |
| | | Postgres, Redis, MinIO containers | already (LexFirma) | `dockerInfra(…)` with adoptable names (§4.5) |
| | | Caddyfile, on-demand TLS behind `/tls/allowed` | yes | `proxy: caddy()` (§8) |
| LexFirma `deploy.sh` | 254 | old flags mapped to the package | — | removed: the package's own commands |

## 2. A typed config, with autocomplete

`defineDeploy` already takes a `DeployConfig`, so editors complete the top-level
fields. Phase 3 makes the rest as precise as the data allows.

### 2.1 The `.env` keys come from the app

```ts
import type { env } from './src/env.js'          // type only: the app is never loaded
import { compose, defineDeploy, secret } from '@basaltkit/deploy'

export default defineDeploy<typeof env>({
  env: {
    file: '/etc/mukanda/api.env',
    fixed: { NODE_ENV: 'production' },            // keys AND values completed: 'development' | 'production' | 'test'
    generate: { MUKANDA_APP_SECRET: secret(32) }, // only keys the schema declares
  },
  backup: { urlKey: 'MUKANDA_OWNER_DATABASE_URL' },
  // …
})
```

- `defineDeploy<E>(config: DeployConfig<E>)`. With `E` given, every place that
  names an app variable takes `Extract<keyof E, string>`:
  - `env.fixed`, `env.generate`, `env.ask`;
  - `backup.urlKey`, `infra.*.urlKey`;
  - the return value of `migrate.env`, and its `values` argument.

  Without `E` they stay `string`, so an app without `@basaltkit/env` loses
  nothing.
- **Values** follow the schema's output type:
  - a `z.enum([...])` key completes its members;
  - a number takes `` `${number}` ``;
  - a boolean takes `'true' | 'false'`.
- `env.forbid` stays `string[]`: it lists keys that are no longer in the schema.
- `import type` is erased at compile time, so `src/env.ts` never runs. This
  keeps RFC 0006 §11.2: the config must not boot the app.

### 2.2 Everything else

- **Docs on hover:** every field gets `@default` and an `@example` in its JSDoc,
  and a link to the RFC section that explains it when it guards against an
  incident.
- **Choices are literal unions:**
  - `tenants: 'subdomain' | 'none'`;
  - `runtime` / `proxy` / `infra` are discriminated unions built by helpers
    (`pm2()`, `compose()`, `apache()`, `caddy()`, `dockerInfra()`, `external()`),
    so completion offers only the fields of the target chosen;
  - `--skip` values are typed (`Skippable`).
- **Paths and URLs as template types** where it catches real mistakes:
  `health.path` is `` `/${string}` ``.
- **Names a type cannot know** (compose services, Apache vhosts) are checked by
  `plan`, against `docker compose config --services` and `sites-available/`.
  An unknown name is an error that lists the names that do exist ("did you mean
  `api`?").
- **`basalt-deploy check`**: validates the config and types it with the app's
  `tsc`, without touching the server. It is the step CI runs.

## 3. `basalt-deploy init`

Writes `deploy.config.ts` (refuses to overwrite one) from what it can read,
asking only what it cannot:

| Read from | Fills |
|---|---|
| `package.json`: name, `packageManager`, scripts (`db:deploy`, `tenant:migrate`), workspaces (`web/`) | `app`, `build.web`, `migrate` |
| `prisma/` (central, `prisma/tenants/`) | `build.prisma`, `migrate.tenants` |
| `src/env.ts` (parsed statically, not run) | `env.schema`, the `import type`, `generate` for every `secret()` key, `ask` for required keys without a default, `fixed` for `NODE_ENV` |
| a production compose file (`docker/compose.prod.yml`, `compose.prod.yml`) | `runtime: compose(…)` with each `build:` as an image, the published loopback port as `upstream` |
| no compose file | `runtime: pm2()`, `infra: dockerInfra(app)` for each database or cache the env names |
| on a server (`--server`): `sites-available/`, ports in use, running containers | `proxy: apache({ managed: false, vhosts })` when vhosts already name the domain; container names to adopt (§4.5) |

Asked interactively, or taken as flags:
- the domain;
- whether tenants live on subdomains;
- the branch.

The file it writes:
- carries `import type { env }` and is complete, never a skeleton with TODOs;
- passes `check` before `init` exits.

`create-basalt` runs the same generator with the answers it already asked, so a
new app has a `deploy.config.ts` from its first commit.

## 4. Declarative infra

### 4.1 The app's database role

```ts
postgres: { appRole: { name: 'mukanda_app', urlKey: 'MUKANDA_DATABASE_URL' } }
```

The deploy then does four things:

- **Creates the role** when it is missing, `LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS`. The password comes from the URL at
  `urlKey` and is generated with `env.generate` like any secret. It travels on
  stdin, never in `-c`.
- **Grants, idempotently:**
  - `CONNECT` on the database and `USAGE` on `public`;
  - default privileges from the owner: DML on tables and `USAGE, SELECT` on
    sequences.
- **Covers the companies too** with `migrate.tenants`: the same grants on each
  `tenant_*` schema, after its migration. Today Mukanda's runner does this in
  `db.ts`.
- **Says what it did:** `plan` shows `role mukanda_app: create` or `in place`.

### 4.2 Buckets

```ts
minio: { buckets: [{ name: 'mukanda-documents', versioned: true }, { name: 'mukanda-quarantine', expireDays: 1 }] }
```

The bucket is created if missing. Versioning is turned on. The expiry rule is
added **once**: the deploy reads the rules first, because adding one on every
deploy is what `deploy-prod.sh` did, and the rules piled up. The credentials are
the running container's (`MC_HOST_*` in the environment), never the config's.
LexFirma's existing `buckets: string[]` keeps working.

### 4.3 Attaching containers the project does not own

```ts
compose({ …, attach: { 'mukanda-postgres': ['data'], 'mukanda-redis': ['data', 'sandbox'], minio: ['data', 'sandbox'] } })
```

- **What:** connects each container to `<project>_<network>` before `up`.
- **When:** on a fresh server the networks do not exist yet, so the deploy
  creates the project first (`up --no-start`, the same step `provision.sh`
  takes) and attaches the containers.
- **Order:** this is what makes the first release healthy, not the second.
- **Check:** `plan` reports a container that is missing or not running as an
  error.

### 4.4 One-off jobs before the release

```ts
compose({ …, jobs: [{ service: 'freshclam', command: ['freshclam', '--stdout'], once: { volume: 'mukanda-clamdb', exists: 'main.c?d' } }] })
```

- **How it runs:** `docker compose run --rm` of a service in the file, with this
  commit's images, after the build and before the release. A failure stops the
  deploy before anything is replaced.
- **`once`:** skips the job when the volume already holds the file.
- **Why it is generic:** it covers ClamAV's first download, and also an asset
  warm-up or a search index rebuild in another app.

### 4.5 Adopting containers by name

`dockerInfra(app)` names its containers `<app>-pg`, `<app>-redis` and
`<app>-minio`. Each service now takes `container: '…'`, so containers a server
already runs under other names are adopted rather than duplicated. For Mukanda
these are `mukanda-postgres`, `mukanda-redis` and `minio`.

`external()` keeps meaning "not this deploy's to create". With `container`
given, the deploy:
- checks that the container exists and is running;
- uses it for §4.1–§4.3 and for the backup, which replaces `backup.container`
  (that field stays, as an alias).

## 5. Migrations

There is nothing new in the package. The convention changes: an app's own
migration steps are a `package.json` script, and `migrate.command` names it.
For Mukanda, `scripts/deploy/migrate.sh` becomes a `db:deploy` script that runs
`db:generate && tsx scripts/db.ts deploy && tsx scripts/db.ts status`.
`migrate.env` keeps rewriting the container hostnames for the host.

## 6. Verify

```ts
verify: {
  logs: { 'ingest-worker': ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'] },  // since the release started
  http: [{ path: '/readyz', expect: 200 }],                              // more URLs than health.path, optional
}
```

- **Logs:** `verify.logs` reads `docker compose logs --since=<release start>`
  for each service and fails the release when a pattern appears. A failure here
  is a failed release, rolled back as `verify` hooks are today.
- **Checks only the app can make** belong in its readiness endpoint, not in the
  deploy. "The image carries the company migrations" is such a check: Mukanda's
  `/readyz` should fail without them. Then the health step already covers it,
  and any orchestrator would too.

## 7. `basalt-deploy bootstrap`

`sudo basalt-deploy bootstrap --user=<deploy user>`, once per server, on Ubuntu
or Debian. Each piece is installed only when missing, and `--dry-run` shows the
list:

- the base packages, Docker with compose, and Node at `engines.node`;
- pnpm at `packageManager`, the version C9 requires;
- swap when RAM is under 6 GB, with `bootstrap.swapGb`;
- ufw, turned on only when nothing but SSH listens publicly (the rule from
  `provision.sh`);
- Caddy, when `proxy` is `caddy()`.

It then runs `install`. A new server is three commands: `git clone`,
`sudo … bootstrap`, `… run`. Generating secrets is `env.generate`, and the
first `run` writes the `.env`. Nothing about a server lives in a `deploy.conf`
any more.

`bootstrap` is the only command that installs packages. It never runs from
`run`.

## 8. The `caddy` target

Planned in RFC 0006 and not built until an app needed it. It now replaces
`provision.sh`'s Caddyfile:

```ts
proxy: caddy({ onDemandTls: { ask: '/tls/allowed' }, sites: { 'partilha.aipro.ao': { pages: ['/enviar*', '/'] } } })
```

- **Where it writes:** like `apache()`, `install` writes the site file, in
  `/etc/caddy/sites/<app>.caddy`, imported from the main Caddyfile.
- **On every run:** `run` diffs it and never overwrites it.
- **Checks:** C1 and C2 have their Caddy equivalents. `caddy validate` runs
  before every reload.
- **Not managed:** `managed: false` checks only.

## 9. Mukanda and LexFirma after phase 3

**Mukanda's config** (sketch):

```ts
export default defineDeploy<typeof env>({
  app: 'mukanda', domain: 'mukanda.aipro.ao', tenants: 'subdomain',
  env: { file: '/etc/mukanda/api.env', mirror: ['/etc/mukanda/worker.env'], schema: 'src/env.ts', fixed: { NODE_ENV: 'production' }, generate: { /* … */ } },
  infra: external({
    postgres: { container: 'mukanda-postgres', urlKey: 'MUKANDA_OWNER_DATABASE_URL', appRole: { name: 'mukanda_app', urlKey: 'MUKANDA_DATABASE_URL' } },
    redis: { container: 'mukanda-redis' },
    minio: { container: 'minio', buckets: [{ name: 'mukanda-documents', versioned: true }, { name: 'mukanda-quarantine', expireDays: 1 }] },
  }),
  build: { web: 'web' },
  migrate: { command: ['pnpm', 'db:deploy'], env: hostUrls },
  runtime: compose({
    file: 'docker/compose.prod.yml', images: [/* … */], upstream: { service: 'api', port: 3001 },
    attach: { 'mukanda-postgres': ['data'], 'mukanda-redis': ['data', 'sandbox'], minio: ['data', 'sandbox'] },
    jobs: [{ service: 'freshclam', command: ['freshclam', '--stdout'], once: { volume: 'mukanda-clamdb', exists: 'main.c?d' } }],
  }),
  verify: { logs: { 'ingest-worker': ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'] } },
  proxy: apache({ managed: false, vhosts: ['mukanda-app.conf', 'mukanda-share.conf'] }),
  health: { path: '/readyz', timeoutSeconds: 240 },
})
```

**Mukanda** removes `scripts/deploy/` and `scripts/provision.sh`, and the shim
`deploy-prod.sh`. Its `/readyz` takes over the check that the image carries the
company migrations.

**LexFirma** removes `deploy.sh`, and its `DEPLOY.md` names the package's
commands.

## 10. Phases

Each of these is one PR, released as a minor version:

1. **Types and `check`:** `DeployConfig<E>`, the documented fields, `check`.
   The types are additive, so the existing configs keep compiling.
2. **`init` and `create-basalt`.**
3. **Infra and verify:**
   - `appRole`, the bucket options, `container`, `attach`, `jobs`;
   - `verify.logs` and `verify.http`;
   - Mukanda adopts them and deletes its three scripts. LexFirma deletes
     `deploy.sh`.
4. **`bootstrap` and `caddy()`:** Mukanda deletes `provision.sh`. A fresh VM
   then goes from `git clone` to `run` and is checked end to end before this is
   called done.

## 11. Decisions

Decided 2026-10-12 by the product owner: the three recommendations below.

1. **Where `bootstrap` installs Node from.** NodeSource (what `provision.sh`
   does) or the official tarball pinned to `engines.node`. **Decided:**
   NodeSource. It updates with `apt`, and C9 already refuses a Node that does
   not satisfy `engines`.
2. **Rootless Docker in `bootstrap`** (RFC 0006 §11.4). Today, `bootstrap`
   gives the deploy user the `docker` group and says plainly that it is
   root-equivalent. **Decided:** rootless as a separate phase. It means moving
   every volume, and it should not block removing the scripts.
3. **Company grants (§4.1):** done by the package after `tenant:migrate`, or
   left to the app's runner. **Decided:** the package, for every app with
   `migrate.tenants`. A new company schema without grants is an outage the app
   role only finds at runtime.
