---
"create-basalt": minor
---

Interactive scaffolds now install dependencies and initialize git by default.

`npm create basalt my-app` in a terminal ends in a runnable app: dependencies are installed (with the detected package manager) and a git repository is initialized, so the "Next steps" shrink to `cd` + `run dev`. The wizard's install/git prompts default to yes.

CI and non-TTY runs are never surprised: with no explicit flag, install/git are skipped there with a clear message (`--install` / `--git` force them). New `--no-install` / `--no-git` flags opt out anywhere; explicit flags always win over the environment. New export: `resolveRunDefaults` (the pure policy, unit-tested).
