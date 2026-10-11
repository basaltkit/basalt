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

```ts
import { apache, ask, defineDeploy, dockerInfra, pm2, secret } from '@basaltkit/deploy'

export default defineDeploy({
  app: 'lexfirma',                     // names everything it owns: lexfirma-api, lexfirma-pg, …
  domain: 'lexfirma.aipro.ao',
  tenants: 'subdomain',                // also checks the *.domain certificate and DNS
  branch: 'master',
  env: {
    schema: 'src/env.ts',              // your defineEnv(): the .env is validated against it
    fixed: { NODE_ENV: 'production', HOST: '127.0.0.1' },
    generate: { APP_SECRET: secret(32) },
    ask: {
      MAILER_URL: ask.secret('SMTP URL', { optional: true }),
      PROXYPAY_SECRET_TOKEN: ask.secret('ProxyPay token'),
    },
    derive: ({ domain }) => ({ PROXYPAY_CALLBACK_URL: `https://${domain}/api/webhooks/proxypay` }),
    forbid: ['PROXYPAY_FAKE'],
  },
  infra: dockerInfra('lexfirma', {
    postgres: { urlParams: { schema: 'public' } },
    minio: { buckets: ['lexfirma-documents', 'lexfirma-backups'] },
  }),
  build: { prisma: ['prisma.config.ts', 'prisma/tenants/prisma.config.ts'], web: 'web' },
  migrate: { central: true, tenants: true },
  runtime: pm2({ avoid: [3000, 3001] }),   // runs the package.json "start" script
  proxy: apache(),                         // web/dist at /, /api/ → the app
})
```

What is true of one server only (a port taken there, another branch) goes in
`/etc/basalt/<app>.json`: `{ "port": 3002, "infra": { "postgres": { "port": 5434 } } }`.

## On a new server

```sh
# as the app user (never root), in the checkout:
pnpm install
pnpm exec basalt-deploy env        # writes the .env (asks once), starts the containers, validates

# once, as an administrator (node on the file: root often has no pnpm on its PATH):
sudo node node_modules/@basaltkit/deploy/dist/bin.js install --user=<app user>   # Apache vhost, /var/lib/basalt/<app>

# then, every deploy, as the app user:
pnpm exec basalt-deploy run
```

`run` pulls the code itself. Store the git credentials once
(`git config credential.helper store && git fetch`, or a read-only deploy key):
preflight probes the remote with prompts disabled, warns at a terminal and
stops before anything changes when nobody can type them (cron, CI).

The TLS certificate is yours to issue (`certbot --dns-cloudflare -d <domain> -d '*.<domain>'`);
every deploy checks it.

## Commands

| | |
|---|---|
| `plan` | every check, then what `run` would do. Writes nothing, asks nothing. |
| `run` | preflight → fetch → env → infra → build → validate → backup → migrate → release → health → record |
| `env` | the `.env` and the containers only |
| `rollback [--to=<sha>]` | the last healthy release. Code only — the database keeps its migrations. |
| `status` | the last releases and the process |
| `install --user=<name>` | root, once: vhost, state directory |

`--skip=fetch,backup,tls`, `--config=<file>`, `--overrides=<file>`.

## What runs by default

- `prisma migrate deploy` — when `build.prisma` lists a config, or `migrate.central: true`.
- `tenant:migrate` — only with `migrate.tenants`.
- The dump before migrating — when something is migrated and there is a
  Postgres to dump (dedicated, or a `postgres://` URL in the `.env`);
  `backup.beforeMigrate` forces it either way. `plan` says why when it is skipped.

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
- **C11** build a commit whose `packageManager` (pnpm ≥ 12) the lockfile does not record — checked in preflight and again on the commit the fetch brings, before any install.

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
