---
'@basaltkit/deploy': patch
---

New check C11: a `packageManager` the lockfile does not record. pnpm 12 writes the pnpm it runs as into `pnpm-lock.yaml` (`packageManagerDependencies`) and its frozen install refuses a lockfile without it, or with another version — which failed two production deploys half-way through the build after `packageManager: pnpm@12.3.4` was committed with a lockfile written by pnpm 11. It runs in preflight and again on the commit the fetch brings (preflight sees the commit before it), stopping before any install and putting the previous commit back, with the fix: `pnpm install --lockfile-only` with the declared pnpm. Checked when pnpm ≥ 12 is declared or the lockfile already records a version.
