# Deploying to a server

`@basaltkit/deploy` deploys a Basalt app to a single Linux server. One command
covers the `.env`, the Docker infra (Postgres, Redis, SeaweedFS), the build, a
database dump before migrating, the migration, PM2 or Docker Compose, Apache or
Caddy, a health check, and a rollback when the new release does not answer.
`@basaltkit/deploy-ui` is an optional web UI for it. It runs on **your**
machine and drives the same commands over your own `ssh`.

This guide follows one app, `acme`, from a fresh server to everyday deploys:
first from the terminal, then from the UI.

![The deploy UI after a finished run: thirteen steps with timings, and the live log ending in "acme e31d0a7 is live at https://acme.example.com"](/guide/deploy/hero-dark.png)

[[toc]]

## How it works {#how-it-works}

![Architecture: on your machine, the browser talks to basalt-deploy-ui on 127.0.0.1, which starts your system ssh. Over SSH, as the app user, the server runs basalt-deploy from the checkout's node_modules: the app, the dedicated infra and the state directory. Below a trust boundary, root runs only its own pinned copy, for bootstrap and install, and reads install-plan.json as data.](/guide/deploy/architecture.svg)

- **No agent on the server.** Every deploy is a plain command, run over SSH as the
  app user in the app's checkout:
  `node node_modules/@basaltkit/deploy/dist/bin.js <command>`. The version is
  the one your lockfile pins.
- **The config is committed.** `deploy.config.ts` at the app root holds no secret.
  `basalt-deploy init --domain=<host>` writes it from the project. The
  [package README](https://github.com/basaltkit/basalt/tree/main/packages/deploy#the-config)
  documents every option.
- **Root is kept apart.** Root runs only its own pinned copy of the tool, from
  outside the checkout, and only for `bootstrap` and `install`. It never loads
  `deploy.config.ts` or the checkout's `node_modules`, and it reads the app
  user's install plan as data. See [Who runs what](#trust-boundary).
- **The UI adds no access.** It listens on `127.0.0.1` only and runs your
  `ssh` binary with your keys and your `known_hosts`. It can do what your SSH
  account can do, and nothing more.

```sh
pnpm add -D @basaltkit/deploy      # in the app, committed with the lockfile
```

::: warning Never add the UI to the app
`@basaltkit/deploy-ui` must not go in the app's `package.json`, not even as a
devDependency. The deploy runs the app's `pnpm install` on the server, which
installs devDependencies, so the UI would land on every server. Run it with
`npx` on your machine ([below](#start-the-ui)).
:::

## The first server {#first-server}

You need a fresh Ubuntu or Debian server with Node, the app's repository, and a
user for the app. In this guide that user is `deploy` and the checkout is
`/srv/acme`.

### Bootstrap, with a pinned version {#bootstrap}

```sh
sudo adduser --disabled-password deploy && sudo git clone <repo> /srv/acme

# root runs its OWN copy, pinned to the version your lockfile records:
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.1 -- \
  basalt-deploy bootstrap --dir=/srv/acme --user=deploy --dry-run
# read what it would do, then run it again without --dry-run
```

- **Pin the exact version** your `pnpm-lock.yaml` records for
  `@basaltkit/deploy`. `bootstrap` warns when the two differ.
- **`cd /` and `-H` matter.** Inside the checkout, `npx` would pick the
  checkout's own copy, which the app user can change. `-H` gives root its own
  npm cache instead of the user's.
- **`--dir` is required** and is never taken from the working directory. It must
  be an absolute path with no symbolic link in it, made of letters, digits and
  `. _ @ + -`, holding `package.json` and `.git`, and must not be a system
  directory (`/`, `/srv`, `/home`, …). Prefer a checkout under a root-owned
  directory (`/srv/acme`) to one in the user's home: a parent the user can
  write lets it swap the checkout for a link (the Apache vhost guards against
  it; Caddy cannot, and `install` warns).

`bootstrap` installs only what is missing: base packages, Docker with compose,
Node at `engines.node`, and the pnpm your lockfile records. It gives the
checkout and the `docker` group to the user. Then it runs the user's steps **as
the user, in the checkout**: `pnpm install`, `env` (it asks for what it cannot
generate) and `install-plan`. Last, it adds swap and a firewall where needed and
runs `install`. When a step fails, bootstrap stops there. Running it again
redoes nothing that is already done.

::: warning The docker group is root on the machine
A container can mount `/`, so membership in `docker` is root in practice.
`bootstrap` says so. The trust boundary protects against mistakes and a
compromised checkout. It does not protect against the app user itself.
Rootless Docker is the real fix, and it is a later step.
:::

### By hand: install-plan, then the root command {#install-plan}

The same steps without `bootstrap`:

```sh
# as the app user (never root), in the checkout:
pnpm install
node node_modules/@basaltkit/deploy/dist/bin.js env           # writes the .env (asks once), starts the containers, validates
node node_modules/@basaltkit/deploy/dist/bin.js install-plan  # writes the install plan (data) and prints the root command

# once, as an administrator: the command install-plan printed, for example
cd / && sudo -H npx --yes --package=@basaltkit/deploy@0.5.1 -- \
  basalt-deploy install --plan=/srv/acme/.basalt/install-plan.json --user=deploy
```

`install` creates the state directory `/var/lib/basalt/acme`, writes the
Apache or Caddy site, and gives the env files to the user. It prints what it
will do before it writes anything.

### Credentials, TLS and the first deploy {#first-deploy}

`run` fetches the code itself, so store the git credentials once, as the app
user: `git config credential.helper store && git fetch`, or a read-only deploy
key. With Apache the TLS certificate is yours to issue
(`certbot --dns-cloudflare -d <domain> -d '*.<domain>'`). With `caddy()`, Caddy
issues it. Then deploy:

```sh
sudo -u deploy -H sh -c 'cd /srv/acme && node node_modules/@basaltkit/deploy/dist/bin.js run'
```

::: tip Use `node`, not `pnpm exec`
Run the app user's commands with `node node_modules/@basaltkit/deploy/dist/bin.js`.
pnpm 12 and later rewrites `pnpm-lock.yaml` when the lockfile came from another
pnpm, and the deploy refuses a modified tree. Wrap the command in a two-line
`deploy.sh` if you like.
:::

## Everyday deploys from the terminal {#terminal}

Everything below runs as the app user, in the checkout. The output shown is
real `basalt-deploy` output for the `acme` example app, taken from the
package's own human-mode test transcripts (whose commits are `aaaaaaa` and
`bbbbbbb`).

### `plan`: what a run would do {#plan}

`plan` runs every check, then lists what `run` would do. It writes nothing and
asks nothing.

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js plan

==> preflight

==> plan — nothing below has run
    fetch: git fetch -- origin +refs/heads/master:refs/remotes/origin/master && git merge --ff-only refs/remotes/origin/master
    env: add APP_SECRET (generated)
    env: add PAYCO_CALLBACK_URL (derived from the domain/port)
    env: ask PAYCO_SECRET_TOKEN
    env: ask SUPPORT_EMAIL
    build: pnpm install (frozen), prisma generate --config prisma.config.ts, web build
    validate: src/env.ts against the new .env
    backup: skipped (backup.beforeMigrate is false)
    migrate: prisma migrate deploy + tenant:migrate
    release: pm2 acme-api on 127.0.0.1:3002
    health: http://127.0.0.1:3002/health (Host: acme.example.com), then https://acme.example.com/api/health
```

### `run`: deploy {#run}

`run` goes through preflight, fetch, env, infra, build, validate, backup,
migrate, release, health and record:

![A terminal running basalt-deploy run: each step under a "==> step" heading, green "ok" lines for the .env, the release and both health checks, ending with "acme bbbbbbb is live at https://acme.example.com" and exit code 0](/guide/deploy/terminal-run.png)

A preflight problem stops the run before anything changes:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js run

==> preflight
    error [git] tracked files are modified on the server:
         M src/app.ts
      → git stash (or commit them where they belong); a deploy builds what is committed
    error preflight: 1 problem(s) above — nothing was changed
```

When the new release does not answer, the deploy puts the previous commit back
and exits `1`:

```console
==> health
    error the app does not answer on http://127.0.0.1:3002/health

==> restoring the code to aaaaaaa
    pnpm install --frozen-lockfile
    pnpm exec prisma generate --config prisma.config.ts
    pnpm --dir web run build

==> release aaaaaaa
    ok acme-api restarted (pnpm run start, port 3002)
    ok back on aaaaaaa
```

A failed migration is recorded as `failed-migration`, and the deploy prints the
`pg_restore` command for the dump it took before migrating. A release that
applied a migration listed in `destructive` is never rolled back automatically.

### `status` {#status}

`status` shows the last releases (who deployed and from where), the process,
the deploy lock and any hold:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js status

==> acme — last 0 release(s)
    no deploy running
    pm2 acme-api: online (pid 4242, /srv/acme)
```

### `rollback` and holds {#rollback}

```sh
node node_modules/@basaltkit/deploy/dist/bin.js rollback              # the last healthy release
node node_modules/@basaltkit/deploy/dist/bin.js rollback --to=<sha>   # a release you pick
```

A rollback restores **code only**: the database keeps its migrations. A manual
rollback refuses a checkout with local edits, and it **holds** the commit it
left. A scheduled `run` will not deploy that commit again until the branch
moves on. To deploy it anyway, deliberately:

```sh
node node_modules/@basaltkit/deploy/dist/bin.js run --unhold
```

With nothing to go back to, the rollback fails:

```console
$ node node_modules/@basaltkit/deploy/dist/bin.js rollback
    error no earlier release to go back to; pass --to=<sha>
```

### One deploy at a time, and exit codes {#exit-codes}

`run`, `env`, `rollback` and `install` take a lock in the state directory. A
second deploy is refused, and the message says who holds the lock. The first
Ctrl-C stops `run` at the end of the current step. From the release on, the
command finishes first.

| Exit code | Meaning |
|---|---|
| `0` | done |
| `1` | failed, or refused (a preflight problem, a held commit, a failed release) |
| `3` | another deploy holds the lock; nothing was done |
| `130` | stopped by a signal (a second signal ends the process at once: `130`/`129`/`143`) |

Useful options: `--skip=fetch,backup,tls`, `--config=<file>`,
`--actor=<name>` (recorded with the release; default `$BASALT_DEPLOY_ACTOR`,
else `$USER`). `--json` switches to machine mode: NDJSON events, used by the UI
and by scripts. Machine mode also gives you detached runs:
`run --json=1 --detach`, `attach <runId> --json --follow`, and
`cancel <runId>`. See the
[package README](https://github.com/basaltkit/basalt/tree/main/packages/deploy#machine-mode-json).

## Deploying from the local UI {#ui}

The UI needs a server that was deployed once from a terminal, as above, and an
SSH account (the app user) that you can already reach with `ssh`.

### Start it {#start-the-ui}

On your machine, never on the server:

```console
$ npx @basaltkit/deploy-ui@0.1.1
basalt-deploy-ui: listening on http://127.0.0.1:53119/ (this machine only)
basalt-deploy-ui: targets in ~/.config/basalt/deploy-targets.json
```

It opens your browser with a one-time code in the URL, valid for 120 seconds.
With `--no-open`, it prints the URL instead. On a machine shared with other
users, use `--pair`: the browser opens without the code, and you type the short
pairing code the terminal shows. Pin an exact version, because this
tool handles your deploy secrets. Other options: `--targets=<file>`,
`--ssh=<absolute path>`, `--idle-minutes=<n>` (default 15). There is no
`--host` and no `--port` option: the UI always listens on `127.0.0.1`, on a port
the OS picks.

The UI stops after 15 idle minutes. An open live log or a running command keeps
it alive. To stop it yourself, use **Quit** on the page or press `Ctrl-C`.
Detached runs go on on the server.

### Add a target {#add-a-target}

A target is one server: an SSH destination and the checkout's directory. In
**Targets**, choose **Add a target**:

![The "Add a target" form: name staging-eu, SSH destination acme-staging-eu (a Host alias), checkout /srv/acme, node on the server set to an nvm path, and the Protected checkbox](/guide/deploy/ui-target-add.png)

| Field | |
|---|---|
| Name | `a-z`, `0-9`, `-`. The UI's key; it is never put in a command. |
| SSH destination | `[user@]host`, or a `Host` alias from your `~/.ssh/config` |
| Port | optional; otherwise your `~/.ssh/config`, else 22 |
| Checkout on the server | the absolute path of the app's checkout |
| node on the server | optional absolute path, [for nvm](#node-path) |
| Config file | optional, relative to the checkout (default `deploy.config.ts`) |
| Protected | deploy and rollback need the target's name typed |

Targets live in your config directory, in
`~/.config/basalt/deploy-targets.json` (`%APPDATA%\basalt\` on Windows),
written `0600`, never in the app repository. The file holds no secret. It
names where your key and the `.env` answers you type are sent, so a commit to a
shared repository must not be able to change it.

Then choose **Check connection**. A working target answers with the deploy
version, the protocol and the server's host name:

![The Targets page: three targets (staging, production marked protected, preview) and a green banner "staging answers: @basaltkit/deploy 0.5.1, protocol 1, host web-1.example.com"](/guide/deploy/ui-targets.png)

### SSH keys: `~/.ssh/config` {#ssh-config}

The UI runs `ssh` in batch mode: it never asks for a password, a passphrase or
a host-key confirmation. Keys, jump hosts and proxies go in `~/.ssh/config`,
and the target names the alias:

```ssh-config
Host acme-prod
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/acme_deploy
  IdentitiesOnly yes
```

- **`IdentityFile`** with **`IdentitiesOnly yes`** makes ssh offer only that
  key. Without `IdentitiesOnly`, ssh offers every key in your agent first, and
  a server with a low `MaxAuthTries` can refuse you before it sees the right one.
- **A key with a passphrase** must be in your agent:
  `ssh-add ~/.ssh/acme_deploy` (on macOS, `ssh-add --apple-use-keychain`).
- **Check from a terminal first.** `ssh acme-prod` must work without a prompt.
  The UI does exactly what that command does.

### The first connection: `known_hosts` {#known-hosts}

The UI always passes `StrictHostKeyChecking=yes`, so it refuses a host you have
never verified, whatever your config says (`accept-new` does not apply). Connect
once from a terminal, compare the fingerprint with the server's own
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, run on the server), and
answer `yes`:

```sh
ssh acme-prod true
```

Until you do, **Check connection** shows the `host-key` error:

![A red banner on the Targets page: "this host's key is not in your known_hosts, or it changed [host-key]", with the hint "connect once from a terminal (ssh deploy@192.0.2.30) and check the fingerprint"](/guide/deploy/ui-error-host-key.png)

### `node` under nvm {#node-path}

`ssh host cmd` starts a non-interactive shell, which does not read the files
where nvm, fnm or volta put `node` on `PATH`. If the check reports `no-node`,
ask a login shell on the server where `node` is, and put that path in the
target's **node on the server** field:

```sh
ssh acme-prod 'bash -lc "command -v node"'
# /home/deploy/.nvm/versions/node/v22.11.0/bin/node
```

From `@basaltkit/deploy` 0.5.1 on, the deploy also puts that directory first on
`PATH` for everything it starts (`pnpm`, the app's scripts). Enable the pnpm
your `packageManager` declares in that Node with `corepack enable`.

### Status {#ui-status}

**Status** shows what runs on the server now: the current release, the
process, the lock and the last run. It loads once when you choose a target.
Choose **Refresh** to load it again; the UI does not poll.

![The Status page for staging: current release b7e4c19d2a0f (healthy, deployed by alice via ui, migration 20261010_add_invoices), process pm2 acme-api running, lock free, last run exit 0](/guide/deploy/ui-status.png)

The bar at the top always shows where you are: the target, its SSH destination
and checkout, and, once the server answered, its host name, the deploy version
and the app.

### Plan & deploy {#plan-and-deploy}

**Plan & deploy → Run plan** runs `plan` on the server. Nothing changes there.
Findings come first, each with its check ID and a fix. An error blocks the
deploy until you fix it on the server and choose **Plan again**:

![Plan with a blocking finding: "ERROR [git] tracked files are modified on the server: M src/app.ts", fix "git stash (or commit them where they belong)", and a C8 certificate warning](/guide/deploy/ui-plan-blocking.png)

With no error, the page shows the plan and the form for what the run will ask:

![Plan & deploy: one C8 warning about the certificate expiry with the fix "certbot renew", the list of what a run would do (fetch, env, build, validate, backup, migrate, release, health), and the form "What the run will ask"](/guide/deploy/ui-plan.png)

### The `.env` form {#env-form}

The questions come from `env.ask` in `deploy.config.ts`. Secret answers are
password fields. They are sent once, over your ssh, to the deploy on the server,
and the fields are emptied after sending. The UI never stores them.

![The "What the run will ask" form: a PayCo token secret field, a Region choice, an optional Support address with a default, an Advanced section, and the buttons "Write .env only…" and "Deploy…"](/guide/deploy/ui-env-form.png)

- **Write .env only…** runs `env`: the `.env` and the dedicated infra, with
  nothing built or restarted. Use it for a first setup.
- **Advanced → Attended** runs the deploy attached to the page: it stops at its
  next step if the page closes or the UI quits. By default a run is
  **detached**, so a closed laptop lid does not stop it.
- When a commit is held, a **Deploy anyway** checkbox appears. It is
  `run --unhold`.

### Confirm {#confirm}

**Deploy…** opens a confirmation that repeats the destination, the checkout,
the server's host name and the app. It says so when the run will migrate the
database. The focus starts on **Cancel**, never on the destructive button:

![The confirmation dialog "Deploy to staging?" showing deploy@staging.example.com · /srv/acme · host web-1.example.com · app acme, "This will migrate the database.", and the buttons Cancel and Deploy](/guide/deploy/ui-dialog-deploy.png)

If the targets file changed after the dialog opened, the UI sends nothing and
shows the new values.

### The live run {#live-run}

The run page shows the steps with their timings and the live log. Build and
migration output is tagged with its source (`[pnpm]`, `[prisma]`, `[vite]`):

![A live run at the backup step: lock, preflight, fetch, env, infra, build and validate done with timings; the log shows a C8 warning, the fetch b7e4c19 → e31d0a7, the build output and the pg_dump to /var/lib/basalt/acme/backups](/guide/deploy/ui-run-live.png)

When it ends, the page shows the release, its URL and its migrations:

![The finished run: "Release e31d0a7c4b9f: ok", https://acme.example.com, migrations 20261011_add_refunds, "Finished: exit 0", all thirteen steps done](/guide/deploy/ui-run-finished.png)

### Re-attach and cancel {#reattach-cancel}

- **A dropped connection** re-attaches by itself, from the next event, without a
  gap or a duplicate line.
- **Stop watching** leaves the run going on the server. **Re-attach** follows it
  again, and **Show from the start** replays the whole log.
- **From another session** (a new tab, after a restart of the UI, or from a
  colleague's terminal), **Status** shows the **Active run** with an
  **Attach** button, and the **Last run** with **Show its log**.
- **Cancel…** asks the deploy to stop at the next step boundary before the
  migration. From the migration on, the deploy finishes first.
  **Cancel again (stop now)…** opens a second, separate confirmation: it ends
  the deploy mid-step, a migration may be left half-applied, and the log holds
  the restore command for the pre-deploy dump. The server decides which cancel
  it is, so a cancel already sent from a terminal counts.

### History and rollback {#history}

**History** lists the last 10 releases the server recorded: the commit, status,
actor, how it ran (`ui`, `ssh`, …), the client address, the migrations and the
dump taken before them.

![History: four releases, one failed with the note "the app does not answer on http://127.0.0.1:3002/health", and the Roll back card with "Back to: the last healthy release (the deploy decides)" and a Roll back… button](/guide/deploy/ui-history.png)

**Roll back** goes to the last healthy release, or to one you pick under **Back
to**. As in the terminal, it restores code only and holds the commit it leaves.
The rollback runs detached, and the page opens its live log.

### Protected targets {#protected}

Mark production **Protected**. The top bar then shows a red strip and a
**PROTECTED** badge on every page. Status shows the hold banner, an active run
from someone else, and the lock it holds:

![Status of the protected production target: red PROTECTED badge in the top bar, a held-commit banner "Commit 4c8e2a6f0b3d is held since 2026-10-07 by bob, rolled back to 9a1f3c7", an active run by bob with an Attach button, and the lock held by pid 5100](/guide/deploy/ui-status-protected.png)

Deploy, **Write .env only** and rollback on a protected target require the
target's name typed in the dialog. The button stays disabled until the name
matches:

![The dialog "Roll back production?" with the PROTECTED badge, "Back to the last healthy release.", and the name only partly typed, so the Roll back button is still disabled](/guide/deploy/ui-dialog-rollback-protected.png)

### On a phone or a narrow window {#narrow}

The layout folds into one column: the navigation becomes tabs and the target
bar wraps.

<img src="/guide/deploy/ui-phone.png" alt="The deploy UI at phone width: the target selector and tabs at the top, the run page with Cancel… and Stop watching, and the steps list at the backup step" width="320">

## Troubleshooting {#troubleshooting}

Connection errors show a short code in brackets. The UI never tries to fix
them itself; each one maps to something you do from a terminal.

| The UI says | Code | Do |
|---|---|---|
| the server refused your SSH key | `auth` | Is the key in your agent (`ssh-add -l`)? Does `ssh <destination>` work from a terminal? Set `IdentityFile` and `IdentitiesOnly yes` ([SSH keys](#ssh-config)). |
| your SSH key needs its passphrase, and ssh runs here in batch mode | `passphrase` | Add the key to your agent: `ssh-add`. |
| this host's key is not in your known_hosts, or it changed | `host-key` | Connect once from a terminal and check the fingerprint ([known_hosts](#known-hosts)). If the key changed and you did not expect it, stop and find out why. |
| node was not found on the server for a non-interactive shell | `no-node` | Set the target's **node on the server** to an absolute path ([nvm](#node-path)). |
| the checkout has no installed @basaltkit/deploy | `no-deploy` | Run `pnpm install` in the checkout once from a terminal. |
| the target's dir does not exist on the server | `no-dir` | Check the target's checkout path. |
| the host name does not resolve | `resolve` | Check the SSH destination, or the `Host` alias in `~/.ssh/config`. |
| the connection timed out / was refused | `timeout` / `refused` | Is the server up, and is sshd listening on that port? |
| no protocol output from the server | | Does the account have a POSIX login shell (`sh`, `bash`, `zsh`)? Is `@basaltkit/deploy` recent enough to have `--json`? |

These come from the deploy's own preflight, and appear as findings in the plan
and in a run's log:

| Finding | Meaning | Fix |
|---|---|---|
| `[state-dir]` `/var/lib/basalt/<app>` is missing or not reachable by this user | The deploy's state (release history, lock, dumps) stays in the checkout. | Run `install-plan`, then the root command it prints. `install` makes the directory the user's own (`0700`) and its parent enterable. |
| `[dumps]` database dumps go to … inside the checkout, and git does not ignore them | A dump of the whole database could be committed. | Add `/.basalt/` to `.gitignore`, or run `install` once, so dumps go to `/var/lib/basalt/<app>/backups`. |
| `[dumps]` … inside the Docker build context | A `COPY . .` would put them in the image. | Add `.basalt` to `.dockerignore`, or run `install` once. |
| `[dumps]` dump(s) left in `backups/predeploy` (the old place) | Nothing prunes them any more. | Move them next to the new ones, or delete them. |
| `[C9]` node is not on PATH / older than `engines.node` | The toolchain the deploy will call is missing or too old. | Set the target's `node` path, or install the Node `engines.node` asks for. |
| `[C9]` pnpm is not on PATH, or another major than `packageManager` declares | | `corepack enable`. It then runs the declared version. |
| `[C9]` pm2 / docker compose is not available to this user | | `npm i -g pm2` as the app user, then `pm2 startup`; for compose, check Docker and the user's `docker` group. |

A held commit (`run` refused with `held`) is not an error to fix: push a fix (the
hold ends when the branch moves on), or use **Deploy anyway** (`--unhold`). An
exit code `3` (`locked`) means another deploy is running. Its holder is on the
Status page.

## Security: what the UI can and cannot do {#security}

**It can** do what your SSH account can do on the server, as the app user:
`status`, `plan`, `env`, `run`, `attach`, `cancel` and `rollback`, each as one
`ssh` invocation of the app's own lockfile-pinned
`node node_modules/@basaltkit/deploy/dist/bin.js <command> --json=1 --via=ui`.

**It cannot:**

- **run root's commands**, or code-writing ones. `install`, `bootstrap` and
  `init` are not reachable from the UI.
- **be reached from another machine.** It listens on `127.0.0.1` and a port
  the OS picks, never `0.0.0.0` or `localhost`, and nothing ever listens on the
  server.
- **be driven by another web page.** It accepts one browser session: a one-time
  launch code, exchanged for a token kept in that tab, not a cookie. Every
  request is checked for the exact `Host`, `Origin` and token, and the UI never
  sends CORS headers. The CSP is strict and framing is denied.
- **weaken your ssh.** It always passes `BatchMode=yes`,
  `StrictHostKeyChecking=yes` and `ForwardAgent=no`, with argv only and `--`
  before the destination.
- **keep your secrets.** They travel browser → loopback → `ssh` stdin, never in
  argv, the environment, a file, a log or the URL. The deploy redacts them from
  every event it writes on the server.
- **trust server output.** Every line is validated and rendered as text only,
  so a build that prints a fake event shows up as a plain log line.

Its limits: on a machine shared with other users, the launch code is visible
in the browser opener's arguments for an instant. A claim by anyone else makes
your tab fail loudly, and the terminal says so; `--pair` removes that window.
When the terminal says the UI
stopped, close the tab. The full threat model is in
[RFC 0009](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0009-deploy-local-ui.md).

### Who runs what: the trust boundary {#trust-boundary}

| Who | Runs | Can change |
|---|---|---|
| the app user | `env`, `run`, `rollback`, `plan`, `status`, `install-plan`; the app itself | the checkout (`deploy.config.ts`, `node_modules`, every file), its `.env`, the state directory |
| root | `bootstrap`, `install`, from a copy of the tool that root owns | everything |

Root never runs the app user's code. `install` reads the data-only install
plan and validates every field again. As root, `install` and `bootstrap` refuse
to run from files another user can change (the checkout, a user's npm cache, a
per-user Node). The app user's commands refuse to run as root.

## See also {#see-also}

- [Going to Production](/guide/production): the checklist, and
  [Build & ship](/guide/production#build-ship) for the Dockerfile route.
- [PostgreSQL backups](/guide/backup): scheduled backups beyond the pre-migration dump.
- `@basaltkit/deploy` and `@basaltkit/deploy-ui` READMEs: every option of
  `deploy.config.ts`, Docker Compose apps, external infra and hooks.
- RFCs [0006](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0006-basalt-deploy.md)
  (the pipeline), [0008](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0008-deploy-machine-protocol.md)
  (machine mode), [0009](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0009-deploy-local-ui.md)
  (the UI) and [0010](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0010-deploy-seaweedfs.md)
  (SeaweedFS in place of MinIO).
