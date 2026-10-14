---
"@basaltkit/deploy": patch
---

Fixes found on the first real server (nvm, an older install):

- Everything the deploy starts (`pnpm`, `node`, the app's scripts) gets the directory of the node it runs on first on `PATH`. Under nvm, fnm or volta, a non-interactive shell (`ssh host cmd`, cron, `@basaltkit/deploy-ui`) has no `node` or `pnpm` on `PATH`, and `plan` failed with `[C9] node is not on PATH` even when the deploy itself was started with node's absolute path.
- A new preflight warning, `state-dir`, when `/var/lib/basalt` exists but `/var/lib/basalt/<app>` is missing or not reachable by the app user. Before, the deploy fell back to `<checkout>/.basalt` without saying so.
- `install` makes `/var/lib/basalt` 0755 when it finds it 0700, so the app user can reach its own 0700 directory below.
- The `dumps` hint for dumps left in `backups/predeploy` creates the new directory first (`install -d -m 700 … && mv …`). The `mv` alone failed when no dump had been taken there yet.
