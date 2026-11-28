---
"@basaltkit/deploy": minor
---

Three gaps found on a first real server:

- **A new SeaweedFS store gets a random access key** (20 hex characters) instead of the app's name. The name was then learnt as a secret, and `--json` output redacted it everywhere: in the container, the database user, the state path, which made a failure unreadable. An existing store keeps its key. `seaweedfs.accessKey` still sets one explicitly.
- **The redactor never hides the app's name.** A secret-named key that holds it (`S3_ACCESS_KEY` from older stores, `BASALT_PG_USER`) is no longer redacted. This includes a value learnt from the `.env` before the config was known.
- **`bootstrap` without `packageManager`.** Phase 2 always runs `pnpm install`, but bootstrap only installed pnpm when `packageManager` named it: it planned nothing and died at `pnpm install` with exit 127. It now takes the lockfile's pnpm, else `packageManager`'s, else a pnpm ≥ 9 already on the server. With none of those, it stops up front, in `--dry-run` too, and says to run `corepack use pnpm@<version>`.
- **`install-plan` warns when root's command cannot start**: when `node` is a per-user install (nvm, fnm, volta, asdf) and there is no system Node, `sudo -H npx` fails with `npx: command not found`. The warning gives the NodeSource commands.
