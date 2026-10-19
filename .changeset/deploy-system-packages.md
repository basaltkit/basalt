---
'@basaltkit/deploy': minor
---

`system: { packages: [...] }` — the OS packages an app runs (OCR, PDF tools, `unzip`), as Debian/Ubuntu apt names. Each name must match `[a-z0-9][a-z0-9.+-]{1,62}` (never an option, never shell syntax), once. Every deploy checks them as the app user (`dpkg-query`, argv only): a missing one is the new **C12** error, which stops the run before anything is built and prints `sudo apt-get install -y <missing>`; a server without `dpkg-query` gets a warning. `plan` prints `system: … (installed)` or `(missing: …)`. Root installs them: the install plan carries the list as data (validated again by root, which never loads `deploy.config.ts`), and `bootstrap` (phase 3) and `install` run `apt-get update` and `apt-get install -y --no-install-recommends` for the missing ones, non-interactively, after a "yes" at the terminal (`bootstrap --dry-run` shows the commands).
