---
'@basaltkit/cli': minor
---

`basalt new <name> [flags]`: the global launcher scaffolds an app. It runs `create-basalt@latest` with the same arguments (`pnpm dlx` when pnpm is installed, else `npx`; `--pm=` picks the manager), so it always gets the latest scaffolder whatever the launcher's version, and keeps the exit code. Outside an app, `basalt` now suggests `basalt new my-app`.
