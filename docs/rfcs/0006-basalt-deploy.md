# RFC 0006 — `basalt deploy`: one deploy pipeline for Basalt apps on a single server

- **Status:** Draft
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-11
- **Affects:** new package `@basaltkit/deploy`; `create-basalt` (the `bin/basalt.ts` prelude forwards `deploy`); no change to any runtime package
- **Non-negotiables honoured:** no HTTP surface is added; nothing runs inside the booted app; secure-by-default (secrets are never printed, logged or written outside a `0600` file); fail-closed (a check that cannot run blocks the deploy, it does not pass it)

---

## 0. TL;DR

Two Basalt apps in production — Mukanda and LexFirma — each grew a deploy script
of 480–850 lines of bash: `scripts/deploy-prod.sh` (Docker Compose images, Caddy
or no proxy) and `deploy.sh` (PM2, host Apache). They do the same eleven things
in a different order, with different bugs, and both learned their lessons from
production incidents that the other script still does not know about.

This RFC proposes **`basalt deploy`**: one pipeline, a typed config file per app,
and swappable **targets** for the two things that genuinely differ between apps —
how the process runs (`pm2` | `compose`) and what sits in front of it (`apache` |
`caddy` | `none`). Every lesson from those incidents becomes a **preflight check**
that runs on every deploy, for every app.

It is TypeScript, not a separate Rust binary: the hard part of a Basalt deploy is
knowing Basalt — the env schema, the two Prisma clients, `tenant:migrate`, the
wildcard tenant hosts — and that knowledge already lives in TypeScript. Node is
already on every server that runs a Basalt app.

Preview environments (one per branch) are phase 3; their hard problem is data
and hostnames, not tooling (§7).

## 1. Scope

**Goals**

1. Deploy a Basalt app to one Linux server, from a clean machine with Docker and
   Node to a healthy app, and every update after that — with the same command.
2. Create and maintain the app's `.env`: generate what can be generated, ask once
   for what cannot, never ask again, never print a secret.
3. Refuse to deploy a configuration that would fail at runtime: validate the
   `.env` against the app's own `defineEnv` schema **before** touching anything.
4. Never touch what the app does not own: other PM2 processes, other containers,
   other vhosts on a shared server.
5. Take a database dump before migrating; roll the code back automatically when
   the health check fails.
6. `--plan` shows every step and every file it would write, and writes nothing.

**Non-goals**

- Several servers, Kubernetes, autoscaling, blue/green across hosts.
- Provisioning the machine (users, firewall, swap, Docker install). Mukanda's
  `bootstrap` step stays a script; `basalt deploy` starts where Docker and Node exist.
- Issuing TLS certificates. Certbot DNS-01 stays the operator's step; `deploy`
  **checks** that the certificate covers the apex and `*.domain` (§5, check C8).
- Replacing CI. CI builds and tests; `deploy` runs on the server.

## A. Current state

| Step | Mukanda `scripts/deploy-prod.sh` | LexFirma `deploy.sh` |
|---|---|---|
| Config | `/etc/mukanda/deploy.conf` + `--init-config` | env vars + prompts |
| `.env` | `write_env_files` (`FORCE_ENV=0` keeps existing) | `setenv`/`ask`/auto-repair, `.env.bak-<date>` |
| Infra | `ensure_vm_infra` (pg, redis, minio, clamav containers) | `docker-compose.server.yml` (pg, redis, minio), reuses passwords from running containers |
| Code | `git pull --ff-only` | `git pull --ff-only`, refuses a dirty tree |
| Build | Docker images tagged by SHA | `pnpm install`, 2× `prisma generate`, `web` build |
| Backup | — | `pg_dump` to `backups/predeploy/`, keeps 10 |
| Migrate | in a one-off container | `prisma migrate deploy` + `basalt tenant:migrate` |
| Release | `compose up -d` | `pm2 restart` (recreated when its cwd differs) |
| Proxy | Caddy, or `PROXY=none` | none (Apache configured by hand) |
| Health | `/readyz` on loopback **and** through the public URL, ingest-worker DNS, tenant migrations present in the image | `/health` on loopback with `Host:` |
| Rollback | previous SHA's images | previous SHA, reinstall, restart |
| State | `/etc/mukanda/current-sha` | none (git `HEAD@{1}`) |

Incidents that shaped them (each becomes a check in §5):

1. **Proxy to the wrong port.** The LexFirma vhost proxied `/api/` to `:3000`,
   which on that server is Apache itself serving another site; the API answered
   nothing and the app showed someone else's HTML.
2. **`sites-enabled/` held copies, not symlinks.** The wildcard certificate was
   written to `sites-available/` and never served.
3. **PM2 ran the app from an old clone.** `pm2 restart` restarted code from a
   directory the deploy no longer updated; `ERR_MODULE_NOT_FOUND` on generated code.
4. **Another app's PM2 process** (`api`) on the same server. A blanket
   `pm2 restart all` or `delete` would have taken down a production app.
5. **`.env` lines split in two** by a prompt whose echo went to stdout; Compose
   refused the file (`unexpected character`).
6. **`PROXYPAY_FAKE="0"` meant true.** `z.coerce.boolean` reads any non-empty
   string as `true`; the fake payment gateway was enabled by the line meant to
   disable it.
7. **A Postgres volume with an old password.** A fresh password in `.env` against
   an initialised volume: `P1000` at migrate time.
8. **Wildcard DNS proxied by Cloudflare** served the apex certificate on tenant
   hosts; `*.domain` must be DNS-only with a Let's Encrypt wildcard on the origin.
9. **Package manager flags drift** (`pnpm --prod=false` refused by pnpm 11).

## 2. Placement: a package with its own entry, not a `runCli` command

`runCli` boots the app before it resolves a command. A deploy must run when the
`.env` is missing, the database is down, or the code on disk does not compile yet
— booting first would make every one of those a crash instead of a diagnosis.

So, like `update | add | doctor | info`, `deploy` is forwarded by the
`bin/basalt.ts` prelude **before** the app is imported:

```
pnpm basalt deploy [plan|run|rollback|status|env] [--config=…] [--yes]
```

It lives in **`@basaltkit/deploy`**, a devDependency of the app, not in
`create-basalt`: `create-basalt` is run as `npx create-basalt@latest`, and a
deploy must be pinned by the app's lockfile — the server runs exactly the
pipeline that was tested with that commit. `create-basalt update` adds the
forwarding line to an existing `bin/basalt.ts`, as it already does for the
project commands.

## 3. The config file

`deploy.config.ts` at the app root. TypeScript because it is typed against the
targets, and because two fields are functions of other values. **It holds no
secrets** and is committed.

```ts
import { defineDeploy, pm2, apache, dockerInfra, secret, ask } from '@basaltkit/deploy'

export default defineDeploy({
  app: 'lexfirma',                       // owner label: names every process, container, vhost, backup
  domain: 'lexfirma.aipro.ao',
  tenants: 'subdomain',                  // 'subdomain' → checks *.domain DNS + certificate; 'none'
  branch: 'master',

  env: {
    file: '.env',                        // 0600, backed up before every write
    schema: 'src/env.ts',                // the app's own defineEnv(), validated in a child process
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: secret(48) },
    ask: {
      MAILER_URL: ask.secret('SMTP URL (smtps://user:pass@host:465)'),
      PROXYPAY_SECRET_TOKEN: ask.secret('ProxyPay token'),
      PROXYPAY_ENTITY: ask.text('ProxyPay entity'),
    },
    derive: ({ domain }) => ({ PROXYPAY_CALLBACK_URL: `https://${domain}/api/webhooks/proxypay` }),
    forbid: ['PROXYPAY_FAKE'],           // must not exist at all in production
  },

  infra: dockerInfra({                   // or: external() — the URLs are in .env, nothing to run
    postgres: { image: 'postgres:16', port: 'auto' },
    redis: { image: 'redis:7-alpine', port: 'auto' },
    minio: { image: 'minio/minio:RELEASE.2025-03-12T18-04-18Z', port: 'auto', buckets: ['files', 'backups'] },
  }),

  build: {
    prisma: ['prisma.config.ts', 'prisma/tenants/prisma.config.ts'],
    web: 'web',                          // pnpm --dir web build; omit when there is no frontend
  },
  migrate: { central: true, tenants: true },  // prisma migrate deploy + basalt tenant:migrate
  backup: { beforeMigrate: true, keep: 10 },

  runtime: pm2({ entry: 'src/server.ts', port: 'auto', avoid: [3000, 3001] }),
  proxy: apache({ vhost: 'lexfirma.conf', webRoot: 'web/dist', apiPrefix: '/api' }),
  health: { path: '/health', public: true },
})
```

Mukanda's would differ in three fields:

```ts
  infra: external(),                     // its containers come from docker/compose.prod.yml
  runtime: compose({ file: 'docker/compose.prod.yml', images: 'sha', services: ['api', 'worker', 'ingest-worker'] }),
  proxy: none(),                         // Apache on the host, DocumentRoot /srv/mukanda/web/dist
```

**Server-local overrides** (a port, a container name adopted from a manual
install) go in `/etc/basalt/<app>.json`, never in the committed file. That is what
`/etc/mukanda/deploy.conf` is today.

## 4. The pipeline

Fixed order; each step is idempotent, prints one line when there is nothing to
do, and is skippable by name (`--skip=backup`) only where skipping is safe.

| # | Step | Writes | Notes |
|---|---|---|---|
| 1 | **preflight** | nothing | every check in §5 that does not need the new code |
| 2 | **fetch** | git | `--ff-only`; refuses a dirty tree; records the previous SHA |
| 3 | **env** | `.env` | §6 |
| 4 | **infra** | containers | adopt-or-create (§6.3); waits for health; creates buckets |
| 5 | **build** | `node_modules`, generated clients, `web/dist` | install with `NODE_ENV` unset; a failure here stops **before** anything running changed |
| 6 | **validate** | nothing | the env schema check again, against the **new** code's `env.ts` |
| 7 | **backup** | `backups/predeploy/<sha>-<time>.dump` | `pg_dump -Fc` of the central database; keeps N |
| 8 | **migrate** | database | central, then tenants |
| 9 | **release** | process | runtime target |
| 10 | **proxy** | vhost | proxy target; `apachectl configtest` before reload |
| 11 | **health** | nothing | loopback with `Host:`, then public URL, then a tenant host |
| 12 | **record** | state file | §8 |

On failure at 9–11 the pipeline runs **rollback**: the previous SHA, rebuilt (or
its images), released, health-checked. Migrations are not reverted — see §8.

`basalt deploy plan` runs 1 and prints 2–12 with the exact commands and file
diffs (secret values masked), like `create-basalt update` prints its plan.

## 5. Preflight checks — the incidents, made permanent

Each check has an id, a fix printed in one line, and a severity. Errors block;
warnings are printed and listed again at the end.

| Id | Check | From |
|---|---|---|
| C1 | The upstream port is free **or** owned by this app's process (`ss -ltnp` → pid → PM2 name / container label). Never a port owned by anything else — including the proxy itself. | incident 1 |
| C2 | Apache: the vhost in `sites-enabled/` is a symlink to `sites-available/`. A regular file is an error with the `diff` and the `a2ensite` fix. | 2 |
| C3 | PM2: the process named `<app>-api` runs from this directory; otherwise it is recreated (not restarted). | 3 |
| C4 | Ownership: the runtime only names processes, containers and volumes prefixed with `app`; any operation on another name is refused at plan time, not at run time. There is no "all". | 4 |
| C5 | `.env` syntax: every non-comment line is `KEY=value`; values needing quotes are quoted. Reported by line number, never by value. | 5 |
| C6 | **Coercion trap:** for every key whose raw value is `0`, `false`, `no` or `off` and whose parsed value is `true`, error. Generic — it needs no list of boolean keys. | 6 |
| C7 | Infra credentials: a running or stopped container's password is read back and must equal the `.env` one; a volume initialised with another password is an error, with the reset command printed, never run. | 7 |
| C8 | TLS: a handshake to the apex and to a random `x<hex>.domain` (SNI) returns a certificate whose SAN covers it and that expires in > 14 days. DNS of `*.domain` resolves to this server (i.e. not proxied). | 8 |
| C9 | Tooling: Node ≥ engines, the package manager the lockfile names, `pg_dump` major ≥ server major. | 9 |
| C10 | `forbid` keys absent; `fixed` keys equal. | 6 |

## 6. The `.env` step

### 6.1 Writing

- Read without sourcing (no shell expansion of a value).
- One backup per run (`.env.bak-<time>`, `0600`), then atomic write (temp + rename).
- Order: `fixed` → `generate` (only when absent) → `derive` → `ask` (only when
  absent or empty) → `infra` URLs → `forbid` removed.
- Prompts read from the TTY with echo off for `ask.secret`; anything the prompt
  prints goes to stderr. Non-interactive runs (`--yes`, CI) take the value from
  the process env under the same name, or fail listing the missing keys.
- The summary lists keys as `added | kept | changed | removed`, never values.

### 6.2 Validating

`src/env.ts` calls `defineEnv(...)` at import. The step runs, in a child process,
`node --env-file=<file> --import tsx -e "await import('<schema>')"` with an empty
inherited environment (so the server's shell cannot mask a missing key), and
reports `EnvValidationError`'s aggregated list. Then C5, C6, C10.

### 6.3 Infra: adopt or create

For each service: if a container labelled `basalt.app=<app>` exists, adopt it and
read its credentials back (C7); if a container with the conventional name exists
but no label, adopt it after confirmation and label it; else create it on a free
loopback port. URLs are written to `.env` from what is actually running, never
from defaults.

## 7. Preview environments (phase 3)

`basalt deploy preview up <branch>` / `down <branch>` / `list`, on the same server:

- process `<app>-pv-<slug>`, a free port, a vhost for `<slug>.preview.<domain>`;
- its own **database** in the app's Postgres (`<app>_pv_<slug>`), migrated and
  seeded with the app's demo seed — never a copy of production data;
- `.env` derived from production's with every external integration (mailer,
  payments, inbound mail) forced to its fake or log driver, and C6/C10 enforced
  the other way round;
- a TTL; `down` drops the database and the bucket prefix.

**Open problem — tenant hosts.** A certificate wildcard covers one label:
`*.preview.domain` serves `pr12.preview.domain` but not
`acme.pr12.preview.domain`. Options: `acme--pr12.preview.domain` with a resolver
that understands the separator, a per-preview wildcard certificate (rate limits),
or the header resolver behind an auth wall. To be decided before phase 3.

## 8. State and rollback

`/var/lib/basalt/<app>/releases.json`: one entry per release — SHA, time,
migrations applied (central and per tenant count), backup file, health result,
who ran it. `basalt deploy status` prints the last ten. This replaces
`/etc/mukanda/current-sha`.

Rollback restores **code**, not the database. Apps must keep migrations
expand/contract (add, backfill, switch, drop in a later release) so that release
N-1 runs on schema N. When a release's migrations are marked `destructive` in
`deploy.config.ts`, automatic rollback is disabled for that release and the
health failure prints the restore command for the pre-migration dump instead.

## 9. Targets — the interface

```ts
interface RuntimeTarget {
  readonly kind: 'pm2' | 'compose'
  preflight(ctx: DeployContext): Promise<Finding[]>
  build?(ctx: DeployContext, sha: string): Promise<void>      // compose: images tagged by SHA
  migrateCommand(ctx: DeployContext, args: string[]): Command  // pm2: host; compose: one-off container
  release(ctx: DeployContext, sha: string): Promise<void>
  upstream(ctx: DeployContext): { host: '127.0.0.1'; port: number }
}

interface ProxyTarget {
  readonly kind: 'apache' | 'caddy' | 'none'
  preflight(ctx: DeployContext): Promise<Finding[]>
  plan(ctx: DeployContext): FileWrite[]   // shown in `plan`, applied only by `run`
  apply(ctx: DeployContext): Promise<void> // configtest, then graceful reload
}
```

Every side effect goes through an injected `Host` (exec, fs, tty, network), as
`ProjectCommandDeps` does for the project commands, so the pipeline is tested end
to end with a fake host — including each incident in §A as a regression test.

## 10. Phases

| Phase | Delivers | Adopted by |
|---|---|---|
| 0 | This RFC | — |
| 1 | Package, config, pipeline, `.env` step, checks C1–C10, `pm2` + `apache`/`none`, `dockerInfra`, backup, health, rollback, state | LexFirma: `deploy.sh` becomes `pnpm basalt deploy run` |
| 2 | `compose` runtime (SHA images, one-off migrate container), `caddy`, adopting containers created by a script | Mukanda: `deploy-prod.sh` keeps `bootstrap`, the rest delegates |
| 3 | Previews (§7), after the tenant-host question is decided | both |
| — | A Rust agent | only if phase 3 grows into a long-running service across several servers |

## 11. Open questions

1. `deploy.config.ts` vs. a plain `deploy.json` validated by a schema — TS reads
   better and types the targets; JSON needs no loader on the server. Proposed: TS,
   loaded with the `tsx` the app already has.
2. Should `deploy` own Apache vhost **creation**, or only check it (C1, C2) and
   print the vhost? Proposed: create on first run, check afterwards, never rewrite
   a vhost that differs from what it would write — print the diff instead.
3. Where `pnpm basalt deploy` runs as root vs. as the app user. Proposed: the app
   user, with a narrow sudoers entry for `apachectl`/`systemctl reload apache2`.
