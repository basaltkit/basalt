---
"create-basalt": patch
---

Scaffolded `bin/basalt.ts` explains a database that refuses the app's role (permission denied) or needs a baseline (P3005) with the fix from `@basaltkit/prisma`'s diagnosis, instead of reporting it as unreachable or unmigrated; `src/server.ts` prints that fix above the stack trace when the boot fails (BK-041).
