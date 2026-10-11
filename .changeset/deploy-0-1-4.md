---
'@basaltkit/deploy': patch
---

What the first `install` on a server showed. The install hint is now `sudo "$(command -v node)" node_modules/@basaltkit/deploy/dist/bin.js install --user="$USER"`: with a per-user Node (nvm, fnm, volta) root has no `node` on its PATH, and `sudo node …` failed with "command not found". No message suggests `pnpm exec basalt-deploy` any more — pnpm ≥ 12 may rewrite `pnpm-lock.yaml` on any command in the checkout; the closing line of `install` and the "no PORT yet" error now give `node node_modules/@basaltkit/deploy/dist/bin.js run|env` (new export `RUN_COMMAND`), and the README and usage say why. The state-directory step of `install` now says what it did: the directory and its owner, how many releases it copied (or that it kept the existing history), and whether it created `/etc/basalt/<app>.json`.
