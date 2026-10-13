---
'@basaltkit/deploy': minor
---

Phase 0 review fixes (RFC 0006 §14). **Breaking (0.x minor):**

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
