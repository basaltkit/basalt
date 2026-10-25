---
'@basaltkit/cli': patch
---

`basalt dev` holds one app, not two: the CLI's own boot, which only reads the route table, is shut down before the server starts (it kept a database pool and every connection open for the whole session). It also runs `src/dev.ts` first when present, which is what `pnpm dev` runs in a create-basalt app (`.env` and `NODE_ENV=development` before the server). Before, it skipped `dev.ts` and ran `src/server.ts`.
