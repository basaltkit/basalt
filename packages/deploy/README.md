# @basaltkit/deploy

One deploy pipeline for a Basalt app on a single Linux server: the `.env`,
dedicated Docker infra (Postgres, Redis, MinIO), PM2, Apache, a database dump
before migrating, a health check, and a rollback when the new release does not
answer. Design and decisions: [RFC 0006](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0006-basalt-deploy.md)
and [RFC 0007](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0007-deploy-zero-scripts.md).

```sh
pnpm add -D @basaltkit/deploy
```

**Illustrated guide:** [Deploying to a server](https://basaltkit-docs.pages.dev/guide/deploy)
walks through a first server, everyday deploys from the terminal and the local
UI, with screenshots and a troubleshooting table
([Português](https://basaltkit-docs.pages.dev/pt/guide/deploy)).

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

A fresh Ubuntu or Debian with Node, three commands. Root runs **its own copy**
of the tool, pinned to the exact version your lockfile records (here `0.5.0`),
from outside the checkout — never the checkout's `node_modules`, which the app
user can change ([who runs what](#who-runs-what-the-trust-boundary)):

```sh
sudo adduser --disabled-password myapp && sudo git clone <repo> /srv/myapp
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.0 -- basalt-deploy bootstrap --dir=/srv/myapp --user=myapp   # --dry-run first
sudo -u myapp -H sh -c 'cd /srv/myapp && node node_modules/@basaltkit/deploy/dist/bin.js run'   # as myapp, from then on
```

`bootstrap` installs only what is missing — base packages, Docker with compose,
Node at `engines.node` (NodeSource), the pnpm the lockfile records — gives the
checkout and the `docker` group to the user (said plainly: that group is root on
the machine; rootless Docker is a later step), then, **as the user, in the
checkout**: `pnpm install`, `env` (it asks what it cannot generate) and
`install-plan`. From that plan (data, validated) it adds swap when RAM is under
6 GB (`bootstrap.swapGb`), ufw with SSH and 80/443 (turned on only when nothing
else listens; `--no-firewall`), Caddy when the proxy is `caddy()`, and runs
`install`. It never loads `deploy.config.ts` itself. A step that fails stops it;
running it again redoes nothing done. It warns when the lockfile records
another `@basaltkit/deploy` version than the one running.

`--dir` is required and is never taken from the working directory (root runs
from `cd /`): it must be an absolute path with no link in it, holding
`package.json` and `.git`, and not a system directory (`/`, `/etc`, `/home`,
`/srv`, `/usr/…`, `/var/lib/…`). Giving the checkout to the user (`chown -R`)
asks first. The user's steps never run on root's terminal: `pnpm install` and
`install-plan` in a new session (`setsid -w`, no controlling terminal), `env`
in a terminal of its own (`script`, which root runs). Without that, on sudo
< 1.9.14 with a kernel < 6.2 (Debian 12, Ubuntu 22.04) a postinstall script
could type into root's shell (TIOCSTI). A Ctrl-C stops bootstrap, not a step
already running in its own session.

By hand, the same thing:

```sh
# as the app user (never root), in the checkout:
pnpm install
node node_modules/@basaltkit/deploy/dist/bin.js env           # writes the .env (asks once), starts the containers, validates
node node_modules/@basaltkit/deploy/dist/bin.js install-plan  # writes the install plan (data) and prints the root command

# once, as an administrator — the command install-plan printed, e.g.:
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.0 -- basalt-deploy install --plan=/srv/myapp/.basalt/install-plan.json --user=myapp

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

As the app user, in the checkout (`node node_modules/@basaltkit/deploy/dist/bin.js <command>`):

| | |
|---|---|
| `init --domain=<host>` | writes `deploy.config.ts` from the project (`--server`: also from this server), then `check` |
| `check` | the config is valid and types check (your `tsc`). No server needed — for CI. |
| `plan` | every check, then what `run` would do. Writes nothing, asks nothing. |
| `run` | preflight → fetch → env → infra → build → validate → backup → migrate → release → health → record |
| `env` | the `.env` and the containers only |
| `rollback [--to=<sha>]` | the last healthy release. Code only — the database keeps its migrations. Holds the commit it left. |
| `status` | the last releases (who, from where), the process, the deploy lock, a hold |
| `install-plan [--out=<file>\|-]` | what `install` needs, as JSON (default `<state dir>/install-plan.json`, 0600), and the root command to run |
| `attach <runId> --json [--from-seq=<n>] [--follow]` | the events of a run, from any point (machine mode, below) |
| `cancel <runId> [--first-only]` | SIGTERM to a detached run; a second `cancel` stops it at once (`--first-only` refuses instead) |
| `ui` | prints how to start the local UI ([`@basaltkit/deploy-ui`](../deploy-ui#readme)) — on your machine, never on the server |

As root, with a copy of the tool root owns (`cd / && sudo -H npx --yes --package=@basaltkit/deploy@<version> -- basalt-deploy <command>`):

| | |
|---|---|
| `bootstrap --user=<name> --dir=<checkout> [--dry-run]` | a fresh server, once (above); `--dir` is required |
| `install --plan=<file> --user=<name>` | once per server: the state directory, the proxy site, the env files' owner |

Options: `--skip=fetch,backup,tls`, `--config=<file>`, `--overrides=<file>`,
`--actor=<name>` (recorded with the release; default `$BASALT_DEPLOY_ACTOR`,
else `$USER`), `run --unhold`, `--allow-root`, `--unsafe-tool`, and the
machine-mode flags below (`--json`, `--answers=stdin`, `--answer-timeout`,
`--detach`, `--via=ui`).

Exit codes: `0` done · `1` failed or refused · `3` another deploy holds the
lock · `130` stopped by a signal (a second signal ends the process at once:
`130`/`129`/`143`).

### One deploy at a time

`run`, `env`, `rollback` and `install` take `<state dir>/deploy.lock` (created
exclusively, 0600) with the pid, host, start time, actor and command. A second
deploy is refused with exit code 3 and says who holds it; a lock whose process
is gone (same host) is taken over — for a detached run, once no process it
started is left. `status` shows it.

The first Ctrl-C (or SIGTERM/SIGHUP) stops `run`/`env` at the end of the
current step: `run` puts the code back and records the release as `aborted`.
From the release on — and during `rollback` and `install` — the command
finishes first; a second signal stops it at once, and with it the step's
processes when the deploy leads its process group (started from a shell, or
detached).

### Releases, rollbacks and holds

Every release in `releases.json` records the sha, the status, the migrations it
applied, the dump taken before them, the OS user and the actor, the SSH client
address (`$SSH_CONNECTION`) and how it ran (`ssh`, `ci`, `terminal`, `batch`).
`audit: { syslog: true }` also sends one line per release to `logger -t
basalt-deploy`.

A rollback onto a commit that does not answer either exits 1 and records it as
`rollback-unhealthy`; the next rollback never picks it. A manual rollback
refuses a checkout with local edits and **holds** the commit it left: a
scheduled `run` will not deploy that commit again until the branch moves on,
or `run --unhold`.

## Machine mode (`--json`)

For a program that drives the deploy — the local UI
([`@basaltkit/deploy-ui`](../deploy-ui#readme), RFC 0009), a script — over the
system `ssh`, as the app user, exactly as a person would type it.
There is no daemon, no listener and no new credential: the program can do what
the SSH account can, nothing more. Design and threat model:
[RFC 0008](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0008-deploy-machine-protocol.md)
(it builds on [RFC 0006](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0006-basalt-deploy.md)).

`--json` (or `--json=1`; any other version is refused) works on `status`,
`check`, `plan`, `run`, `env`, `rollback`, `install-plan`, `attach` and
`cancel`. `init`, `install` and `bootstrap` refuse it. stdout then carries
only NDJSON events, one per line:

```json
{"v":1,"ts":"2026-10-13T10:00:00.000Z","seq":0,"runId":"20261013T100000Z-5f2c9a1b3d4e","type":"hello","tool":"@basaltkit/deploy","version":"0.5.0","protocol":1,"command":"run","pid":4100,"host":"server-1"}
{"v":1,"ts":"…","seq":1,"runId":"…","type":"step-start","id":"lock","title":"lock"}
{"v":1,"ts":"…","seq":2,"runId":"…","type":"step-end","id":"lock","status":"ok","durationMs":3}
{"v":1,"ts":"…","seq":9,"runId":"…","type":"log","stream":"child","level":"info","text":"Done in 4.1s","redacted":false,"step":"build","source":"pnpm"}
{"v":1,"ts":"…","seq":40,"runId":"…","type":"result","command":"run","data":{"sha":"…","previous":"…","status":"ok","migrations":[],"url":"https://myapp.example.com"}}
{"v":1,"ts":"…","seq":41,"runId":"…","type":"done","exitCode":0}
```

- Every stream starts with `hello` and ends with `done`; `seq` counts up by
  one. A stream that ends without `done` ended abnormally (a second signal,
  a kill) — never treat it as success.
- `type` is one of `hello`, `step-start`, `step-end`, `log`, `finding`,
  `prompt`, `result`, `error`, `done` (and `event`, from `attach`). `error`
  carries a `code` (`locked`, `aborted`, `preflight`, `held`,
  `release-failed`, `answer-missing`, …); the exit codes are the ones above.
- What a build, a hook, a migration or `deploy.config.ts` prints (on stdout
  or stderr) is always the `text` of a `log` event (`stream: "child"` or
  `"foreign"`), stripped of terminal escapes, redacted, then cut at 8 KiB —
  data, never interpreted. Every other string of every event is stripped of
  escapes too.
- **No event carries a secret.** Every string is redacted before it is
  written: the values of generated, asked-secret and secret-named `.env` keys,
  passwords inside URLs, the infra passwords, secret-named variables of the
  deploy's own environment, every secret answer — raw and URL-encoded, and a
  multi-line value (a PEM key) also with its newlines escaped and line by
  line — become `[redacted:KEY]`. A name is secret when it holds `SECRET`,
  `TOKEN`, `PASSW`, `PRIVATE`, `APIKEY`, `CREDENTIAL`, a `KEY`, `SALT` or
  `PWD` word, or ends in `_URL`/`_DSN`; declare any other with `generate` or
  `ask.secret`. What the config prints while it loads waits until
  its `.env` has been read. A bare origin in a `*_URL` key
  (`APP_URL=https://app.example.com`) is the app's address and is not
  redacted. A value shorter than 6 characters cannot be matched; a
  `secret-short` warning names its key.
- Types and a validating parser for a program written in TypeScript:

  ```ts
  import { parseEvent, type DeployEvent } from '@basaltkit/deploy/protocol'

  for (const line of output.split('\n').filter(Boolean)) {
    const parsed = parseEvent(line)
    if (!parsed.ok) throw new Error(`corrupt stream: ${parsed.error}`) // stop: never guess
    if (parsed.known) handle(parsed.value) // a type this version does not know is skipped
  }
  ```

  The subpath is pure (no CLI, no Node API at load).

**Answers.** `run` and `env` ask the `env.ask` questions. `plan --json` lists
them in its result (`questions`, never with a value; a secret never with a
default). Send the answers on stdin with `--answers=stdin`, one line each:

```sh
printf '%s\n' '{"v":1,"type":"answer","id":"env.SMTP_URL","value":"smtps://user:pass@smtp.example.com:465"}' |
  ssh -T deploy@192.0.2.10 -- 'cd /srv/myapp && node node_modules/@basaltkit/deploy/dist/bin.js run --json=1 --answers=stdin'
```

An unknown id, a duplicate, a malformed or oversized line fails the command
before the lock is taken. A required question nobody answers fails
(`answer-missing`); an unanswered optional secret is left out of the `.env`.
With stdin kept open, a refused answer is asked again (`prompt` with
`attempt: 2`); a prompt waits `--answer-timeout` seconds (default 600). The
deploy's own environment still answers first. No child process ever reads
stdin.

**Detached runs.** `run --detach --json` (and `rollback --detach --json`)
checks every answer first, starts the deploy in its own session — it survives
the SSH connection — and returns `{runId, pid, log}` once that run holds the
deploy lock:

```sh
node node_modules/@basaltkit/deploy/dist/bin.js run --json=1 --detach --answers=stdin --via=ui --actor=alice < answers.ndjson
node node_modules/@basaltkit/deploy/dist/bin.js attach 20261013T100000Z-5f2c9a1b3d4e --json --follow --from-seq=0
node node_modules/@basaltkit/deploy/dist/bin.js cancel 20261013T100000Z-5f2c9a1b3d4e --json
```

- Every JSON-mode `run`, `env` and `rollback` writes its events to
  `<state dir>/runs/<runId>.ndjson` (0600, in a 0700 directory, created
  exclusively, never through a link). `attach` replays one, wrapped as
  `{"type":"event","event":{…}}`, from `--from-seq` (the inner `seq`), and
  with `--follow` waits for its `done`; a run gone without one is
  `run-vanished`. The newest 50 logs are kept, none older than 30 days; a log
  stops taking output lines at 64 MiB.
- `cancel` sends SIGTERM only to the process holding the lock for that run,
  checked by its own command line (Linux). It stops at the next safe point,
  as Ctrl-C does; a second `cancel` stops it at once, with the step it was
  running (its process group). The lock is taken over by the next deploy
  once no process of that run is left. `cancel --first-only` sends only a
  first signal: when the run was already cancelled once, from any client, it
  is refused (`already-cancelled`) and nothing is signalled. A client that
  asked for the mild cancel never sends the immediate one by surprise.
- `status --json` reports the lock, the active run and the last run.
- `--via=ui` records `via: "ui"` with the release; like `--actor`, it
  attributes, it does not authenticate.

## The local UI

[`@basaltkit/deploy-ui`](../deploy-ui#readme) is a browser UI for all of the
above that runs on **your** machine (`npx @basaltkit/deploy-ui@<exact version>`),
listens on `127.0.0.1` only and drives each server over your own `ssh` with the
machine mode — status, plan, the `.env` questions, a detached run with its live
log, cancel, rollback, history. Never add it to the app's `package.json`: this
package installs the app's devDependencies on the server. Design and security
model: [RFC 0009](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0009-deploy-local-ui.md).

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
Mirrors are rewritten as exact copies; one that differs is a C10 error. Outside
the checkout an env file lives directly in `/etc/<app>/` — nowhere else (never
`/etc/environment`). `install` gives `/etc/<app>` (0700) and the files (0600)
to the deploy user, through descriptors opened without following links: a
symlink or a hard link planted there is refused. The app name picks that
directory, so `install` never takes one that is not the app's: names such as
`systemd`, `ssh`, `apt`, `docker` or `basalt` cannot keep env files in `/etc`
(keep the env in the checkout, or rename the app); a directory a Debian
package ships, one with subdirectories, or one another account owns is
refused; one root created by hand is shown and given only after a "yes". The
state directory `/var/lib/basalt/<app>` is refused too when another account
owns it.

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
  Dumps go to `<state dir>/backups` (0700). Once `install` ran that is
  `/var/lib/basalt/<app>/backups`, outside the checkout — never in an image, a
  commit or a served directory. Before, it is `<checkout>/.basalt/backups`: a
  new app's `.gitignore`/`.dockerignore` exclude `/.basalt` and `/backups`, and
  the preflight warns (`dumps`) when git does not ignore the directory or a
  Docker build would copy it. `backup.dir` (relative to the checkout) keeps
  the old place; dumps left in `backups/predeploy`, the old default, are
  pointed out until they are moved or deleted. When `/var/lib/basalt` exists
  but `/var/lib/basalt/<app>` is missing or not reachable by the app user (a
  parent only root can enter), the preflight says so (`state-dir`) instead of
  falling back to the checkout in silence; `install` makes `/var/lib/basalt`
  0755 (each app's own directory below stays 0700).
- The node it runs on, first on `PATH` for everything it starts (`pnpm`,
  `node`, the app's scripts). With nvm, fnm or volta, a non-interactive shell
  (`ssh host cmd`, cron, the local UI) does not have them on `PATH`; starting
  the deploy with that node's absolute path is enough.
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
- A failed migration is recorded as `failed-migration`: the database may be
  part-way, so the `pg_restore` command for the dump taken before it is printed.
- At `release`/`health`: the previous commit is rebuilt, restarted and checked.
- A release that applied a migration listed in `destructive` is never rolled
  back automatically — its code would run on a schema it does not know. The
  `pg_restore` command for the dump taken before it is printed instead.
- Healthy on `127.0.0.1` but not at `https://<domain>`: exit 1, no rollback —
  the problem is the proxy, DNS or TLS, not the code.

## Who runs what: the trust boundary

| Who | Runs | Can change |
|---|---|---|
| the app user | `env`, `run`, `rollback`, `plan`, `status`, `install-plan`; the app itself | the checkout: `deploy.config.ts`, `node_modules`, every file in the tree; its `.env`; `<state dir>` |
| root | `bootstrap`, `install` — from a copy of the tool root owns | everything |

- **Root never runs the app user's code.** `install` reads a data-only plan
  (`install-plan`), without following a link, and validates every field again:
  the web root (inside the checkout, no dot directories, not the checkout
  itself), the API prefix, the certificate name, the env files (only
  `/etc/<app>/`), the checkout (must be the user's own directory). It never
  loads `deploy.config.ts`, the checkout's `tsx` or `node_modules`, nor reads
  the `.env`. Before writing it prints what it will do. Raw Caddy `extra` and a
  non-default proxy root are shown and need a "yes" at the terminal; `extra`
  may hold no control, direction or zero-width character (what is shown is
  what is written) and no `import`.
- **A plan cannot take another site.** The managed vhost is `<app>.conf` (or
  `<app>-….conf`), and `install` refuses a domain — or a name under its
  wildcard, or a wildcard over it — that another Apache vhost or Caddy site
  already serves (Caddy `extra` site blocks included). The file it replaces
  must be the app's own: written by `install` for it, or serving only its
  names.
- **The served directory follows no planted link out of the user's files.**
  The vhost sets `Options -FollowSymLinks +SymLinksIfOwnerMatch` and
  `AllowOverride None` on the checkout and the web root, and the link rule on
  every directory above the checkout too — a parent the user can write
  (`/home/<user>`) could otherwise hold a link swapped in for the checkout
  itself. `install` refuses a checkout reached through a link, and the plan's
  `dir` is letters, digits and `. _ @ + -` only. Caddy's `file_server` has no
  such option: with `caddy()`, a link in the web root is followed to anything
  the `caddy` user can read — keep secrets of other sites out of its reach,
  and the checkout under a root-owned directory (`/srv/<app>`; `install` warns
  otherwise).
- **A user step never gets root's terminal.** In `bootstrap`, the app user's
  `pnpm install` (and `env` without a terminal) writes to a pipe, not to
  root's terminal: a process a postinstall leaves behind cannot read root's
  keystrokes. Its output is shown line by line, without escape sequences.
- **Root writes only where no other user can plant a link**: directories
  only root can write (`/var/lib/basalt`, `/etc/basalt`, the Apache/Caddy
  roots), or files changed through an `O_NOFOLLOW` descriptor.
- **The tool root runs is checked.** As root, `install` and `bootstrap` refuse
  to run from files another user can change — `sudo node
  node_modules/@basaltkit/deploy/dist/bin.js` from the checkout, a user's npm
  cache, a per-user Node (nvm) — unless `--unsafe-tool`. Run the pinned copy:
  `cd / && sudo -H npx --yes --package=@basaltkit/deploy@<version> -- basalt-deploy …`
  (`cd /`: inside the checkout npx would pick its own copy; `-H`: root's npm
  cache, not the user's), or a root-owned global install (`sudo npm install -g
  @basaltkit/deploy@<version>`) with a root-owned Node (NodeSource's
  `/usr/bin/node`). The check is a guardrail against a mistake, not a
  boundary: it runs inside the copy being checked, so a copy the app user
  changed can drop it. Running the pinned, root-owned copy is the control.
- **The app user's commands refuse root** (`--allow-root` to insist): as root
  they would build and run the app's code, and `deploy.config.ts`, as root.
- **The `docker` group is root on the machine** (a container can mount `/`).
  `bootstrap` adds the user to it so `dockerInfra` and `compose` work, and says
  so; with it, the boundary above protects against mistakes and a compromised
  checkout less than against the app user itself. Rootless Docker for the app
  user is the real fix (`dockerd-rootless-setuptool.sh install`), and moves
  every volume — a later step, not done for you.
