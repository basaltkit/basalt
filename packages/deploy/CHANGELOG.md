# @basaltkit/deploy

## 0.4.1

### Patch Changes

- 93fad8d: The preflight no longer reports `runtime.attach: <container> does not exist` for the dedicated infra's own containers: on a new server the infra step creates them before the release.

## 0.4.0

### Minor Changes

- 79bd887: Dedicated infra for apps that run in compose: `dockerInfra(app, { project, access: 'containers' })` creates the containers in their own compose project and writes URLs that name them (`myapp-pg:5432`), while migrations and the dump get the `127.0.0.1:<published port>` form; a compose runtime sharing its project with its infra is refused. `compose({ passEnv })` hands `.env` values (a Redis URL with its password) to compose interpolation from memory only. The app role's URL follows a recreated database and keeps its password.

## 0.3.1

### Patch Changes

- 99f3b78: The README, the JSDoc examples and the comments shipped in `dist` use generic names (`acme.example.com`, `globex`) instead of the production apps' domains, container names and providers.

## 0.3.0

### Minor Changes

- 9177a6c: Typed config (RFC 0007 §2): `defineDeploy<typeof env>` types every `.env` key the config names (`env.fixed`/`generate`/`ask`/`derive`, `backup.urlKey`, infra `urlKey`s, `migrate.env`) from the app's `defineEnv`, with values following the schema (enum members, digits, `true`/`false`). `health.path` must start with `/`. Every field documents its default. New command `basalt-deploy check`: validates the config and types it with the app's own `tsc`, without a server. Configs without the type argument are unchanged.
  
  `basalt-deploy init` writes `deploy.config.ts` from the project (RFC 0007 §3): the env schema read as text (secrets the app mints are generated, provider-issued ones and required keys asked), Prisma central/tenant migrations or the app's `db:deploy`, `web/`, a production compose file whose images are variables (Dockerfiles from `build:` or `docker/<name>/`), else PM2 with dedicated Postgres/Redis/MinIO from the env keys; with `--server`, the Apache vhosts already serving the domain and the ports taken. It never overwrites a config and runs `check` on what it wrote.
  
  Declarative services (RFC 0007 §4–§6): `external({ postgres: { container, urlKey, appRole }, redis: { container }, minio: { container, buckets } })` checks the containers in the preflight, keeps the app's database role (created when missing, password from the `.env`, DML through default privileges; every `tenant_*` schema after `tenant:migrate`) and the buckets (`versioned`, `expireDays` added once), and dumps inside the external Postgres. `dockerInfra` services take `container` and `appRole`. `compose({ attach, jobs })` connects containers the project does not own to its networks (creating the project first on a fresh server) and runs one-off jobs before `up`; volumes the compose file declares `external` are created when missing. `verify: { logs, http }` fails — and rolls back — a release whose service logs a pattern or whose URL does not answer. Every service and container name is checked in the preflight. The public health check now runs under the health step.
  
  `basalt-deploy bootstrap --user=<name>` prepares a fresh Ubuntu/Debian server (RFC 0007 §7): base packages, Docker with compose, Node at `engines.node`, the pnpm the lockfile records, swap under 6 GB of RAM, ufw only when nothing else listens, Caddy when the proxy is `caddy()`, the checkout and the docker group for the user, then `pnpm install` and `env` as the user and `install` as root; `--dry-run` lists every command. New `caddy()` proxy target (RFC 0007 §8): `install` writes `/etc/caddy/sites/<app>.caddy` (and the main Caddyfile on a stock server, with the on-demand TLS `ask` endpoint), validates and reloads; deploys diff it and check C1/C2/C8. `init --proxy=caddy`.

## 0.2.1

### Patch Changes

- 80dc345: `backup.container`: with external infra, the pre-migration `pg_dump` runs inside the named Postgres container (`docker exec`, password in the environment only), with a preflight check that the container is running and a matching restore command. The public health check now prints its URL when it passes.

## 0.2.0

### Minor Changes

- 70146bd: Phase 2 of RFC 0006 (§13): Docker Compose apps. `compose({ file, images, upstream, env, keepImages })` builds each image once per commit as `<tag>:<7-char sha>` (skipped when it exists), starts the project with `compose up -d`, checks the upstream service's own healthcheck and that no service is restarting, rolls back to the previous commit's images without a rebuild, and after a healthy release removes `<sha>` tags of the configured images outside the last `keepImages` releases (tags must be `<app>` or `<app>-…`, C4). C1 understands a port published by `docker-proxy`. New: `hooks.infra` / `hooks.verify` — the app's own commands at fixed points (a failing `verify` rolls back); `migrate.command` and `migrate.env` (values that override the `.env` for the migration and the pre-migration dump, e.g. host URLs for container names); `env.file` may be absolute and `env.mirror` keeps exact copies (a differing mirror is C10); `apache({ managed: false, vhosts })` checks C1/C2 on vhosts the app writes itself and never writes them; `install` gives an env file outside the checkout — and the app's own directory — to the deploy user. C1 now reads quoted `ProxyPass "/x" "http://127.0.0.1:N/"` lines, which it silently skipped before. Under compose the `.env` gets no `PORT`.

## 0.1.4

### Patch Changes

- 850cb7e: What the first `install` on a server showed. The install hint is now `sudo "$(command -v node)" node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"`: with a per-user Node (nvm, fnm, volta) root has no `node` on its PATH, and `sudo node …` failed with "command not found". No message suggests `pnpm exec basalt-deploy` any more — pnpm ≥ 12 may rewrite `pnpm-lock.yaml` on any command in the checkout; the closing line of `install` and the "no PORT yet" error now give `node node_modules/@basaltkit/deploy/dist/bin.js run|env` (new export `RUN_COMMAND`), and the README and usage say why. The state-directory step of `install` now says what it did: the directory and its owner, how many releases it copied (or that it kept the existing history), and whether it created `/etc/basalt/<app>.json`.

## 0.1.3

### Patch Changes

- 6bab93e: A deploy no longer blocks itself on a lockfile the package manager rewrote. pnpm ≥ 12 rewrites `pnpm-lock.yaml` (`packageManagerDependencies`) on any command run inside the checkout when the committed lockfile was written by another pnpm; that made preflight's own `pnpm --version` dirty the tree it then refused, and left the lockfile modified after `pnpm exec`/`run` for the next deploy to refuse. The version probes (C9) now run outside the checkout, which also reports the pnpm actually installed. The dirty check runs first, before any other command, and when only a lockfile is modified it says it was most likely the package manager and how to get out. A lockfile rewritten during the build, the migrations or the start is put back to the committed version — said once, as a C11 warning, with the fix that belongs in the repository.

## 0.1.2

### Patch Changes

- 19cd5e3: New check C11: a `packageManager` the lockfile does not record. pnpm 12 writes the pnpm it runs as into `pnpm-lock.yaml` (`packageManagerDependencies`) and its frozen install refuses a lockfile without it, or with another version — which failed two production deploys half-way through the build after `packageManager: pnpm@12.3.4` was committed with a lockfile written by pnpm 11. It runs in preflight and again on the commit the fetch brings (preflight sees the commit before it), stopping before any install and putting the previous commit back, with the fix: `pnpm install --lockfile-only` with the declared pnpm. Checked when pnpm ≥ 12 is declared or the lockfile already records a version.

## 0.1.1

### Patch Changes

- 0dd8440: What the first production deploy (Acme) showed. Preflight now probes the git remote with prompts disabled: missing credentials are a warning at a terminal (with how to store them once) and an error without one, before anything changes; a branch missing on the remote is an error. Without a terminal the fetch runs with prompts disabled, so cron and CI fail instead of hanging. `prisma migrate deploy` runs by default only when `build.prisma` is set, and the pre-migration dump only when something is migrated and there is a Postgres to dump (`backup.beforeMigrate` and `migrate.central` still force either way); `plan` says why a step is skipped. The env, infra, validate and release steps print what they did. Every install hint is now `sudo node node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"` (`INSTALL_COMMAND`), which works when root has no pnpm on its PATH.

## 0.1.0

### Minor Changes

- abe7f86: New package (RFC 0006, phase 1): `basalt-deploy` deploys a Basalt app on one Linux server — `plan`, `run`, `env`, `rollback`, `status`, and `install` (root, once). `deploy.config.ts` (`defineDeploy`) declares the `.env` (fixed / generated once / asked once / derived / forbidden), dedicated Docker infra adopted or created by name (`dockerInfra`: Postgres, Redis, MinIO on 127.0.0.1, credentials read back from running containers), the build, migrations (central + `tenant:migrate`), a PM2 runtime and an Apache proxy whose vhost is written only by `install` and diffed, never rewritten, on every deploy. Every run validates the `.env` against the app's own `defineEnv` schema in a child process that sees only the file, dumps the database before migrating, health-checks on loopback and through the public URL, and rolls the code back when the release does not answer (never over a migration marked `destructive`). Preflight checks C1–C10 cover a foreign process on the app port, `sites-enabled` copies, a PM2 process running from another directory, process names outside `<app>-`, malformed `.env` lines, `"0"` read as true by a coerced boolean, a volume given a new password, the apex and wildcard certificates, the package-manager major, and forbidden or drifted keys. Secrets never reach a command line, the compose file or the terminal.
