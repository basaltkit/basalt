---
'@basaltkit/deploy': minor
---

Phase 0 hardening (RFC 0006 §14). **Breaking (0.x minor):**

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
