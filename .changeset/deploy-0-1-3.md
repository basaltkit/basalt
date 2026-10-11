---
'@basaltkit/deploy': patch
---

A deploy no longer blocks itself on a lockfile the package manager rewrote. pnpm ≥ 12 rewrites `pnpm-lock.yaml` (`packageManagerDependencies`) on any command run inside the checkout when the committed lockfile was written by another pnpm; that made preflight's own `pnpm --version` dirty the tree it then refused, and left the lockfile modified after `pnpm exec`/`run` for the next deploy to refuse. The version probes (C9) now run outside the checkout, which also reports the pnpm actually installed. The dirty check runs first, before any other command, and when only a lockfile is modified it says it was most likely the package manager and how to get out. A lockfile rewritten during the build, the migrations or the start is put back to the committed version — said once, as a C11 warning, with the fix that belongs in the repository.
