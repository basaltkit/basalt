---
'@basaltkit/cli': minor
---

A global `basalt` launcher: `npm i -g @basaltkit/cli`, then `basalt <command>` anywhere inside an app runs that app's `basalt` script through its own package manager (`pnpm basalt …`, `npm run basalt -- …`, yarn, bun), with the arguments and the exit code unchanged. The app's code and pinned versions always run, never the launcher's. Outside an app it says so and exits 1.
