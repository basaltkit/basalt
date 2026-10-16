# @basaltkit/deploy

## 0.6.0

### Minor Changes

- b53d878: SeaweedFS in place of MinIO (RFC 0010). MinIO's community edition is archived, and `minio` is removed: `dockerInfra(app, { minio })` and `external({ minio })` are refused with the way out.
  
  - `dockerInfra(app, { seaweedfs: { buckets } })`: one `chrislusf/seaweedfs:4.48` container. Only the S3 API is published (127.0.0.1); master, volume and filer listen on the container's loopback; Iceberg and Lance are off; the admin gRPC requires a generated signing key (4.48 otherwise accepts identities from any neighbour on the network). Healthy once a volume server has joined, not only `/healthz`. Its credentials are not in the data, so new ones on an old volume are a rotation.
  - `external({ s3: { keys, hostEndpoint, buckets } })`: any S3-compatible store, checked with the `.env`'s credentials before the build.
  - Buckets, versioning and the expiry rule over the S3 API (SigV4, signed in the deploy) instead of `mc`: the rule is added next to existing ones, then read back.
  - Moving off MinIO: the README.

## 0.5.4

### Patch Changes

- dcb8660: `bootstrap` refuses to install a pnpm older than 9.0.0 globally as root (the app user's `packageManager`/lockfile picks the version; root now sets the floor). The root tool check is documented as a guard against running the wrong copy, not a defence against a tampered one.

## 0.5.3

### Patch Changes

- 470009c: Security review fixes:
  
  - `bootstrap` no longer hands root's terminal to the app user's steps (`pnpm install`, `env` without a terminal): their output comes through a pipe, line by line, sanitized, so a process a postinstall leaves behind cannot read root's keystrokes. The install-plan error is sanitized too, and root's probes run from `/`, not `/tmp`.
  - The Apache vhost sets `-FollowSymLinks +SymLinksIfOwnerMatch` on every directory above the checkout (a parent the app user can write could hold a link swapped in for the checkout). Installed vhosts show a one-time diff. `install` refuses a checkout reached through a link, and warns under Caddy when a parent is writable by another user.
  - `install` never replaces a site file that is another app's (written by install for it, or serving other names), and Caddy `extra` site blocks are checked against co-hosted sites' names.
  - The plan's `dir` is a closed set of characters (letters, digits, `. _ @ + -`); Caddy `extra` refuses zero-width characters.
  - Redaction knows more secret names (`*_KEY_*`, `PASSWD`, `*_PWD`, `APIKEY`, `PRIVATE`, `SALT`) and catches multi-line values whole, escaped and line by line.

## 0.5.2

### Patch Changes

- b64cfec: The package READMEs link to the new illustrated guide, [Deploying to a server](https://basaltkit-docs.pages.dev/guide/deploy) (English and Portuguese): a first server, everyday deploys from the terminal and the local UI, and troubleshooting. The `@basaltkit/deploy-ui` README also shows a screenshot of the Plan & deploy page.

## 0.5.1

### Patch Changes

- d90a168: Fixes found on the first real server (nvm, an older install):
  
  - Everything the deploy starts (`pnpm`, `node`, the app's scripts) gets the directory of the node it runs on first on `PATH`. Under nvm, fnm or volta, a non-interactive shell (`ssh host cmd`, cron, `@basaltkit/deploy-ui`) has no `node` or `pnpm` on `PATH`, and `plan` failed with `[C9] node is not on PATH` even when the deploy itself was started with node's absolute path.
  - A new preflight warning, `state-dir`, when `/var/lib/basalt` exists but `/var/lib/basalt/<app>` is missing or not reachable by the app user. Before, the deploy fell back to `<checkout>/.basalt` without saying so.
  - `install` makes `/var/lib/basalt` 0755 when it finds it 0700, so the app user can reach its own 0700 directory below.
  - The `dumps` hint for dumps left in `backups/predeploy` creates the new directory first (`install -d -m 700 … && mv …`). The `mv` alone failed when no dump had been taken there yet.
- 50499cf: `passEnv` hands compose the value the env step just wrote. When a deploy changed a passed key (a recreated Redis, a generated URL), the service got the `.env` from before the change and could not authenticate.

## 0.5.0

### Minor Changes

- 9cd8edb: `cancel <runId> --first-only` (RFC 0008 §8.5): sends only a first signal. When the run was already cancelled once, from any client (the `<runId>.cancel` marker on the server says so), it is refused with the new protocol error code `already-cancelled` (exit 1) and nothing is signalled. A client that asked for the mild cancel, which stops at a step boundary, therefore never sends the immediate one by surprise. Additive: a plain `cancel` behaves as before.
- d9bea2b: Machine mode (RFC 0008): a program can drive the deploy over the system `ssh`, as the app user, with no daemon and no listener.
  
  - **`--json`** on `status`, `check`, `plan`, `run`, `env`, `rollback`, `install-plan`, `attach` and `cancel`: stdout carries only NDJSON events in a versioned envelope (`{v:1, type, ts, seq, runId?}`) — `hello`, `step-start`/`step-end`, `log`, `finding`, `prompt`, `result` (a typed payload per command), `error` (with a `code`), `done`. Children's and `deploy.config.ts`'s output is always the text of a `log` event, sanitised, never interpreted. Every string of every event is redacted (generated, asked-secret and secret-named `.env` values, URL passwords, infra passwords, secret answers; raw and URL-encoded) before it is serialised. `init`, `install` and `bootstrap` refuse `--json`.
  - **`--answers=stdin`** for `run` and `env`: answer lines `{"v":1,"type":"answer","id":"env.KEY","value":"…"}`, checked strictly; an unknown id, a duplicate or a malformed line fails before the lock; an unanswered secret never takes a default; `--answer-timeout` (default 600 s). `plan --json` lists the questions.
  - **`run --detach` / `rollback --detach`**: the run starts in its own session and owns the deploy lock (`LockHolder.runId`); `attach <runId> [--from-seq] [--follow]` replays its run log (`<stateDir>/runs/<runId>.ndjson`, 0600, kept 50 / 30 days, 64 MiB cap); `cancel <runId>` sends SIGTERM only to the matching lock holder. `status --json` reports the active and last run. `--via=ui` is recorded as the release's `via`.
  - New subpath **`@basaltkit/deploy/protocol`**: the event and payload types, `parseEvent` and `parseAnswerLine`, with no CLI and no Node API at load.
  - API (additive): `Output` gains `step(title, id?)` and the optional `stepEnd`, `finding`, `result`; `Host` gains the optional `createLog`, `readFileRange`, `spawnDetached`, `kill`, `processCmdline`, and `prompt` an optional third argument; `ExecOptions.onOutput`; `DeployError` gains `code` and `hint`; `RunOptions` gains `via` and `protocol`; `main` takes an optional `CliIO`.
  
  Hardened after review: the config's output is held until its `.env` is learnt (and its load errors reported after), stderr writes are events too, lines are redacted before they are cut (a line past 64 Ki keeps only its first piece), every string of every event is sanitised, nothing follows `done`, a late bad answer line still fails closed, a bare-origin `*_URL` is not redacted, `check` always ends its step, a piped child that leaves a background process no longer holds the deploy, a second signal stops the run's process group and a detached run's lock is not stale while that group lives, and `attach` gives a finished run a moment to write `done`. `@basaltkit/deploy/protocol`'s declarations no longer need Node types; `Host.onSignal` takes an optional `second`, and `Host` gains the optional `processGroupAlive`.
  
  Without `--json` every command prints exactly what it printed before (a snapshot recorded on the previous code guards it). Behaviour changes in human mode: `--via` accepts only `ui`; a second signal also sends SIGTERM to the deploy's process group when it leads one (the step's child no longer outlives it); `cancel` is a new command; `--answers`/`--detach`/`attach` without `--json` are refused.
- 5ef14ee: Phase 0 hardening (RFC 0006 §14). **Breaking (0.x minor):**
  
  - **`install` no longer runs the app user's code as root.** It is now two halves: as the app user, `node node_modules/@basaltkit/deploy/dist/bin.js install-plan` writes a data-only plan and prints the root command; as root, `cd / && sudo -H npx --yes --package=@basaltkit/deploy@<exact version> -- basalt-deploy install --plan=<file> --user=<name>` validates the plan and never loads `deploy.config.ts`, `tsx`, `node_modules` or the `.env`. The old `sudo node node_modules/…/bin.js install --user=<u>` is refused with these instructions. Env files are handed over through `O_NOFOLLOW` descriptors (a planted symlink or hard link is refused), root writes only under root-only directories, and as root `install`/`bootstrap` refuse to run from files another user can change (`--unsafe-tool` to override). The exported `install(ctx, user)` becomes `install(host, plan, user)`; `buildInstallPlan`, `parseInstallPlan` and `readInstallPlan` are new.
  - **`bootstrap` never loads the config**: it runs the user's steps as argv in the checkout (`--dir=<checkout>`), takes the proxy and `bootstrap.*` from the user's install plan (swap, ufw and Caddy now come after `pnpm install`/`env`), runs `install` in-process, and lets `env` ask at the terminal.
  - **Config validation** now refuses: a `branch`/`remote` git could read as an option; `webRoot` outside the checkout, a dot directory or the checkout itself; an `apiPrefix`, `certName`, `proxy.root` or `onDemandTls.ask` that is not a plain path/name; env files outside the checkout other than directly in `/etc/<app>/`; a `backup.dir` that leaves the checkout; a compose job `once.exists` that is not an absolute path pattern.
  - **Root is refused** for `run`, `env`, `rollback` and every command that loads `deploy.config.ts`, unless `--allow-root` (`allowRoot`).
  - **Pre-migration dumps** default to `<stateDir>/backups` (0700) instead of `<checkout>/backups/predeploy`; `backup.dir` keeps the old place.
  - `Host` gains `pid`, `hostname`, `processAlive`, `createExclusive`, `onSignal`, `chmod`, `realpath`, `readPlainFile` and `secureOwner`; `stat` also returns `mode`, `uid` and `gid`.
  
  Also:
  
  - A deploy lock (`<stateDir>/deploy.lock`) for `run`/`env`/`rollback`/`install`: a concurrent deploy exits with code **3**; a stale lock (dead pid, same host) is taken over; `status` shows it.
  - SIGINT/SIGTERM/SIGHUP stop `run`/`env` at the next step boundary (code put back, release recorded `aborted`, exit 130); the release, `rollback` and `install` finish first.
  - `rollback` onto a commit that does not answer exits 1 and records `rollback-unhealthy` (never a rollback target again); it refuses a dirty tree, verifies `--to`, and **holds** the commit it left (`run --unhold` to deploy it anyway).
  - A failed migration is recorded `failed-migration` and prints the `pg_restore` of the pre-deploy dump.
  - The fetch names `refs/heads/<b>:refs/remotes/<r>/<b>` after `--`.
  - The `.env`'s mode/owner are checked, and the mode fixed to 0600 by `env`/`run`.
  - Releases record `actor` (`--actor`, `$BASALT_DEPLOY_ACTOR`, `$USER`), `client` (SSH) and `via`; `audit: { syslog: true }` logs each release with `logger`.
  - C8 now reports an untrusted certificate with its names (the real host never did); the secret prompt refuses to ask rather than echo on a Node without the readline internal it relies on; a compose job's `once.exists` reaches the shell as `$1`, never as script.
- 3ebf5be: Phase 0 review fixes (RFC 0006 §14). **Breaking (0.x minor):**
  
  - **`bootstrap` requires `--dir=<checkout>`** (absolute). It is never taken from the working directory: run as documented from `cd /`, it planned `chown -R <user>: /`. The directory must be a link-free path holding `package.json` and `.git`, not a system directory; the `chown -R` of a checkout the user does not own asks first.
  - **`install` never hands over a directory that is not the app's.** Reserved app names (`systemd`, `ssh`, `apt`, `docker`, `basalt`, …) cannot keep env files in `/etc/<app>/`; an `/etc/<app>` a Debian package ships, one with subdirectories, or any directory or env file another account owns is refused; one root created by hand needs a "yes". `/var/lib/basalt/<app>` owned by another account is refused.
  - **The managed Apache vhost must be `<app>.conf` or `<app>-*.conf`**, and `install` refuses a domain another vhost or Caddy site already serves (or a name under its wildcard).
  - **Caddy `extra`** may not hold control or direction characters, nor `import`.
  - **The rendered vhost changes** (a one-time drift warning on existing installs): `Options -Indexes -FollowSymLinks +SymLinksIfOwnerMatch` and `AllowOverride None` on the checkout and the web root; the vhost and Caddy site headers name the `install-plan` flow.
  - `Host` gains `removeFile` (unlink, never recursive).
  
  Also:
  
  - `bootstrap` runs the app user's steps off root's terminal (`setsid -w`; `env` in its own pty via `script`): no TIOCSTI on sudo < 1.9.14 / kernel < 6.2.
  - The deploy lock is read without following a link and removed with `unlink` only; a stale lock is taken over by one process (an `O_EXCL` takeover file).
  - The fetch refspec is forced again (`+refs/heads/<b>:…`): a branch rewritten upstream after a rollback deploys; `merge --ff-only` still guards the checkout.
  - A bare `rollback` never picks the commit an automatic rollback just left; a signal no longer aborts a deploy once its migration started.
  - The preflight warns (`dumps`) when dumps would go inside the checkout unignored by git or into a Docker build context, and about dumps left in `backups/predeploy`; a hold written before `install` is still read.
  - `install` prints what it is about to do; the printed root command shell-quotes the plan path; `webRoot: './web/dist'` is accepted again; `managed: false` proxies are not held to root's `webRoot`/`apiPrefix` rules.

### Patch Changes

- 7490752: `basalt-deploy ui` prints how to start the local UI (`@basaltkit/deploy-ui`, RFC 0009) on the operator's machine, and exits 0; with `--json` it is refused (`unsupported`). It loads no config and spawns nothing: the package gains no listener and no dependency.

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
