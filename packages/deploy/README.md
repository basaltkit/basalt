# @basaltkit/deploy

One deploy pipeline for a Basalt app on a single Linux server: the `.env`,
dedicated Docker infra (Postgres, Redis, MinIO), PM2, Apache, a database dump
before migrating, a health check, and a rollback when the new release does not
answer. Design and decisions: [RFC 0006](../../docs/rfcs/0006-basalt-deploy.md).

```sh
pnpm add -D @basaltkit/deploy
```

## The config

`deploy.config.ts` at the app root, committed. It holds **no secrets**.
`basalt-deploy init --domain=<host>` writes it from the project:

| Read from | Fills |
|---|---|
| `src/env.ts` (as text — the app is not loaded) | the typed `defineDeploy<typeof env>`; `generate` for each `secret()` the app mints, `ask` for each required key and each provider-issued secret (S3, API, SMTP…) |
| `package.json`, `prisma.config.ts`, `prisma/tenants/` | `app`, `build.prisma`, `migrate` (`central`/`tenants`, or `command: ['pnpm', 'db:deploy']` when that script is the app's own) |
| `web/package.json` | `build.web` |
| a production compose file whose images are variables (`image: ${APP_IMAGE}`) | `runtime: compose(…)`: one image per variable (Dockerfile from `build:`, else `docker/<name>/Dockerfile`), the service on `127.0.0.1` as upstream |
| otherwise | `runtime: pm2()`, `infra: dockerInfra(app)` for the `DATABASE_URL`, `REDIS_URL`, `S3_*` keys the schema has |
| `--server`, on the server | the Apache vhosts that already serve the domain (`managed: false`), the ports taken (`avoid`) |

It asks the domain, the tenancy and the branch (or takes `--domain`,
`--tenants`, `--branch`, `--proxy`), never overwrites a config (`--force`),
and runs `check` on what it wrote.

```ts
import { apache, ask, defineDeploy, dockerInfra, pm2, secret } from '@basaltkit/deploy'

export default defineDeploy({
  app: 'acme',                     // names everything it owns: acme-api, acme-pg, …
  domain: 'acme.example.com',
  tenants: 'subdomain',                // also checks the *.domain certificate and DNS
  branch: 'master',
  env: {
    schema: 'src/env.ts',              // your defineEnv(): the .env is validated against it
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: secret(32) },
    ask: {
      MAILER_URL: ask.secret('SMTP URL', { optional: true }),
      PAYCO_SECRET_TOKEN: ask.secret('PayCo token'),
    },
    derive: ({ domain }) => ({ PAYCO_CALLBACK_URL: `https://${domain}/api/webhooks/payco` }),
    forbid: ['PAYCO_FAKE'],
  },
  infra: dockerInfra('acme', {
    postgres: { urlParams: { schema: 'public' } },
    minio: { buckets: ['acme-documents', 'acme-backups'] },
  }),
  build: { prisma: ['prisma.config.ts', 'prisma/tenants/prisma.config.ts'], web: 'web' },
  migrate: { central: true, tenants: true },
  runtime: pm2({ avoid: [3000, 3001] }),   // runs the package.json "start" script
  proxy: apache(),                         // web/dist at /, /api/ → the app
})
```

What is true of one server only (a port taken there, another branch) goes in
`/etc/basalt/<app>.json`: `{ "port": 3002, "infra": { "postgres": { "port": 5434 } } }`.

### Typed by your env

Give `defineDeploy` the type of your `defineEnv(...)` and every `.env` key the
config names is completed and checked — `env.fixed`, `generate`, `ask`,
`derive`, `backup.urlKey`, the infra `urlKey`s, `migrate.env`. Values follow the
schema: a `z.enum` completes its members, a number takes digits, a boolean
`'true' | 'false'`.

```ts
import type { env } from './src/env.js'   // type only: the app is never loaded
import { defineDeploy } from '@basaltkit/deploy'

export default defineDeploy<typeof env>({
  env: { fixed: { NODE_ENV: 'prod' } },    // ✗ '"prod"' is not assignable to '"development" | "production" | "test"'
  backup: { urlKey: 'DATABSE_URL' },        // ✗ … Did you mean '"DATABASE_URL"'?
  // …
})
```

Without the type argument every key is a plain string, as before.
`basalt-deploy check` runs the same checks without a server — the config's
own validation, then your `tsc` on `deploy.config.ts` with your tsconfig — so
CI catches them too.

## On a new server

A fresh Ubuntu or Debian with Node, three commands:

```sh
git clone <repo> /srv/myapp && cd /srv/myapp
sudo npx -y -p @basaltkit/deploy basalt-deploy bootstrap --user=ubuntu   # --dry-run first, to see it
node node_modules/@basaltkit/deploy/dist/bin.js run                       # as ubuntu, from then on
```

`bootstrap` installs only what is missing — base packages, Docker with compose,
Node at `engines.node` (NodeSource), the pnpm the lockfile records, swap when
RAM is under 6 GB (`bootstrap.swapGb`), ufw with SSH and 80/443 (turned on only
when nothing else listens; `--no-firewall`), Caddy when the proxy is `caddy()` —
gives the checkout and the `docker` group to the user (said plainly: that group
is root on the machine; rootless Docker is a later step), then runs, as the
user, `pnpm install` and `env` (it asks what it cannot generate) and, as root,
`install`. A step that fails stops it; running it again redoes nothing done.

By hand, the same thing:

```sh
# as the app user (never root), in the checkout:
pnpm install
node node_modules/@basaltkit/deploy/dist/bin.js env    # writes the .env (asks once), starts the containers, validates

# once, as an administrator — the node path is resolved by YOUR shell, because
# with a per-user Node (nvm) root has none on its PATH:
sudo "$(command -v node)" node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"

# then, every deploy, as the app user:
node node_modules/@basaltkit/deploy/dist/bin.js run
```

Wrap it in a two-line `deploy.sh` if you like. Run it with `node`, not
`pnpm exec basalt-deploy`: pnpm ≥ 12 rewrites `pnpm-lock.yaml` on any command
in the checkout when the lockfile came from another pnpm, and the deploy
refuses a modified tree.

`run` pulls the code itself. Store the git credentials once
(`git config credential.helper store && git fetch`, or a read-only deploy key):
preflight probes the remote with prompts disabled, warns at a terminal and
stops before anything changes when nobody can type them (cron, CI).

With Apache the TLS certificate is yours to issue (`certbot --dns-cloudflare -d <domain> -d '*.<domain>'`);
every deploy checks it. With Caddy it is Caddy's:

```ts
proxy: caddy({ onDemandTls: { ask: '/tls/allowed' } }),   // tenants: a certificate per host, for hosts the app vouches for
```

`install` writes `/etc/caddy/sites/<app>.caddy` — the apex (and `*.<domain>`
with tenants), `/api/` stripped to the app, `web/dist` with the SPA fallback —
and, on a server still on the package's Caddyfile, a main file that imports it
and asks the app before each certificate. Someone's own Caddyfile only gets the
import line. `caddy validate` runs before the reload; a failure puts every file
back. Deploys diff the site and never rewrite it; C1, C2 (not imported) and C8
(no `ask`) are checked as for Apache.

## Commands

| | |
|---|---|
| `check` | the config is valid and types check (your `tsc`). No server needed — for CI. |
| `plan` | every check, then what `run` would do. Writes nothing, asks nothing. |
| `run` | preflight → fetch → env → infra → build → validate → backup → migrate → release → health → record |
| `env` | the `.env` and the containers only |
| `rollback [--to=<sha>]` | the last healthy release. Code only — the database keeps its migrations. |
| `status` | the last releases and the process |
| `install --user=<name>` | root, once: vhost, state directory |

`--skip=fetch,backup,tls`, `--config=<file>`, `--overrides=<file>`.

## Docker Compose apps

```ts
runtime: compose({
  file: 'docker/compose.prod.yml',
  images: [
    { tag: 'myapp', dockerfile: 'docker/app/Dockerfile', env: 'MYAPP_IMAGE' },
    { tag: 'myapp-worker', dockerfile: 'docker/worker/Dockerfile', env: 'MYAPP_WORKER_IMAGE' },
  ],
  upstream: { service: 'api', port: 3001 },   // published on 127.0.0.1 by the compose file
  env: { MYAPP_API_HOST_PORT: '3001' },       // compose interpolation — never secrets
  keepImages: 3,
}),
```

- Each image is built once per commit as `<tag>:<7-char sha>` and skipped when it
  exists; `compose up -d` gets the tags through the `env` variable of each image.
- Health: the upstream service healthy by its own healthcheck, **no service of
  the project restarting**, then the loopback and public URLs.
- Rollback starts the previous commit's images again — no rebuild. After a
  healthy release, `<sha>` tags of these images outside the last `keepImages`
  releases are removed; nothing else is ever pruned.
- Image tags must be `<app>` or `<app>-…` (C4).

**The env file outside the checkout:** `env: { file: '/etc/myapp/api.env', mirror: ['/etc/myapp/worker.env'] }`.
Mirrors are rewritten as exact copies; one that differs is a C10 error. `install`
gives the files — and `/etc/myapp` itself, when its name contains the app's —
to the deploy user.

**Migrations by command**, with values that override the `.env` for them and for
the pre-migration dump (a container name the host cannot resolve):

```ts
migrate: {
  command: ['./node_modules/.bin/tsx', 'scripts/db.ts', 'deploy'],
  env: (v) => ({ DATABASE_URL: v.get('DATABASE_URL')!.replace('@myapp-postgres:', '@127.0.0.1:') }),
},
```

**Dedicated infra for a compose app** — the containers created by the deploy
too, in their own compose project, reached by name from the app's containers:

```ts
infra: dockerInfra('myapp', {
  project: 'myapp-infra',     // never the runtime's project: each would remove the other's containers
  access: 'containers',       // URLs name the containers (myapp-pg:5432); migrations get 127.0.0.1:<port>
  postgres: { user: 'myapp_owner', urlKey: 'OWNER_DATABASE_URL', appRole: { name: 'myapp_app', urlKey: 'DATABASE_URL' } },
  redis: { urlKey: 'REDIS_URL' },
  minio: { buckets: [{ name: 'myapp-documents', versioned: true }] },
}),
runtime: compose({
  // …
  attach: { 'myapp-pg': ['data'], 'myapp-redis': ['data'], 'myapp-minio': ['data'] },
  passEnv: ['REDIS_URL'],     // a service without env_file gets it through ${REDIS_URL}: from memory only
}),
```

Ports are still published on 127.0.0.1 for the host; the app role's URL
follows the database when it moves (a recreated container) and keeps its
password.

**Services you keep but do not create** (RFC 0007 §4) — containers that outlive
any release, adopted by name:

```ts
infra: external({
  postgres: {
    container: 'myapp-postgres',
    urlKey: 'OWNER_DATABASE_URL',                          // the owner: role, grants and the dump run as it
    appRole: { name: 'myapp_app', urlKey: 'DATABASE_URL' }, // what the app connects as: no DDL
  },
  redis: { container: 'myapp-redis' },
  minio: { container: 'minio', buckets: [{ name: 'myapp-documents', versioned: true }, { name: 'myapp-quarantine', expireDays: 1 }] },
}),
runtime: compose({
  // …
  attach: { 'myapp-postgres': ['data'], 'myapp-redis': ['data', 'sandbox'] },   // onto <app>_<network> before up
  jobs: [{ service: 'freshclam', command: ['freshclam', '--stdout'], once: { exists: '/var/lib/clamav/main.c?d' } }],
}),
verify: {
  logs: { 'ingest-worker': ['EAI_AGAIN', 'ECONNREFUSED'] },   // since the release started; found → rolled back
  http: [{ path: '/readyz' }],
},
```

- **Preflight:** each container running; every service and container name the
  config uses exists (`did you mean "ingest-worker"?`).
- **The role:** created when missing, its password the `.env`'s (generated from
  the owner's URL when the key is absent), proven over TCP before anything is
  changed, granted DML through the owner's default privileges — never on
  existing tables, which an app may keep append-only. With `migrate.tenants`,
  every `tenant_*` schema too, after the migration.
- **Buckets:** created; versioning on; the expiry rule added once — the rules
  are read first. The credentials are the running MinIO's.
- **Attach:** on a fresh server the project is created first (`up --no-start`)
  so its networks exist and the first release is healthy, not the second.
- **Jobs:** `docker compose run --rm --no-deps` with this commit's images,
  before `up`; `once` skips them when the path exists.
- **The dump** runs inside `infra.postgres.container` as the owner.
- `dockerInfra` services take `container` (adopt another name) and `appRole` too.

**Hooks** — what only your app does, as commands that also run by hand:

```ts
hooks: {
  infra: [['bash', 'scripts/deploy/infra.sh']],    // after the .env and infra, before the build
  verify: [['bash', 'scripts/deploy/verify.sh']],  // after the health check; failing rolls back
},
```

They run in the checkout as the deploy user with the `.env` values, the image
variables, `DEPLOY_SHA` and `DEPLOY_APP`. They run on every deploy: idempotent.

**Apache you write yourself:** `apache({ managed: false, vhosts: ['myapp.conf'] })`
checks C2 and C1 on each vhost on every deploy and never writes them.

## What runs by default

- `prisma migrate deploy` — when `build.prisma` lists a config, or `migrate.central: true`; not with a `migrate.command` unless `central: true`.
- `tenant:migrate` — only with `migrate.tenants`.
- The dump before migrating — when something is migrated and there is a
  Postgres to dump (dedicated, or a `postgres://` URL in the `.env`);
  `backup.beforeMigrate` forces it either way. `plan` says why when it is skipped.
  With external infra in a container, `backup: { container: 'myapp-postgres' }`
  runs `pg_dump` inside it (`docker exec`), as the user and database of the
  URL at `backup.urlKey` — the server's own pg_dump, none needed on the host.
  The preflight checks the container is running.

## What it refuses to do

Each of these is a check that runs on every deploy, written after a production
incident (RFC 0006 §5):

- **C1** proxy or bind to a port another process owns — including Apache's own;
- **C2** trust a vhost copied into `sites-enabled/` instead of linked;
- **C3** restart a PM2 process that runs from another directory (it re-creates it);
- **C4** name any process, container or volume that does not start with `<app>-`;
- **C5** write or read a `.env` line that is not `KEY=value` (reported by line, never by value);
- **C6** accept a value meant as *off* that your schema reads as *on* (`z.coerce.boolean()` turns `"0"` into `true`);
- **C7** give an existing database volume a new password;
- **C8** stay silent about a certificate that does not cover the apex or a tenant host;
- **C9** run with a package manager major other than the one `packageManager` declares;
- **C10** keep a forbidden key, or a fixed key with another value.
- **C11** build a commit whose `packageManager` (pnpm ≥ 12) the lockfile does not record — checked in preflight and again on the commit the fetch brings, before any install. A lockfile the package manager rewrites during the deploy is put back to the committed version (with a warning), so the next deploy is not blocked; and no check runs the package manager inside the checkout.

Secrets never reach a command line, the compose file, or the terminal: the
summary names keys, passwords travel in child-process environments only.

**Your app loads its own `.env`** (`import 'dotenv/config'` first in
`src/server.ts`, or `node --env-file=.env`). PM2 starts it with `NODE_ENV`,
`PORT` and `HOST` only: not the operator's shell (a stray variable would
override the file), and not the secrets (`pm2 save` writes the process
environment to `~/.pm2/dump.pm2`).

## When a release fails

- Before `release` (build, validation, backup, migration): the code on disk is
  put back to the previous commit and rebuilt; nothing running was touched.
- At `release`/`health`: the previous commit is rebuilt, restarted and checked.
- A release that applied a migration listed in `destructive` is never rolled
  back automatically — its code would run on a schema it does not know. The
  `pg_restore` command for the dump taken before it is printed instead.
- Healthy on `127.0.0.1` but not at `https://<domain>`: exit 1, no rollback —
  the problem is the proxy, DNS or TLS, not the code.
