---
"@basaltkit/cli": minor
---

`nodeUpgradeFs(baseDir?)` resolves relative paths against the directory being upgraded (default: the current working directory), and `basalt upgrade --dir=<path>` passes it — before, `--dir` listed one tree and read/wrote paths relative to `process.cwd()`. `runCli` now follows `Unknown command "update" | "add" | "doctor" | "info"` with a hint to run `npx create-basalt@latest <command>`: those project commands live in create-basalt, and its `update` teaches an older `bin/basalt.ts` to forward them.
