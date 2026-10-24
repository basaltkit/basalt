---
'@basaltkit/deploy': minor
'create-basalt': minor
---

**deploy:** the `pm2()` runtime gives the app its `env.file`. Before, the process got only `NODE_ENV`, `PORT` and `HOST`: `validate` read the file and passed, then a scaffolded app (`start: node dist/src/server.js`) booted without its secrets — `EnvValidationError`, failed health check. The process now gets the file's path (`BASALT_ENV_FILE`) and a preload in `NODE_OPTIONS` that loads it only in the processes pm2 manages (`pm_id`), so neither the pm2 daemon nor `pm2 save`'s dump ever holds a value. Exported variables still win, a custom or absolute `env.file` is honoured, `NODE_OPTIONS` set in the file is passed on, an unreadable file stops the app with one line. `pm2({ loadEnv: false })` keeps the old minimal environment (preflight warns when the start script then shows no loader). A CI job checks it against real pm2 (start, restart --update-env, kill + resurrect).

**create-basalt:** `start` is now `node --env-file-if-exists=.env --enable-source-maps dist/src/server.js` (with `engines.node >=22.9.0`), and the generated `.env`/`.env.example` no longer set `NODE_ENV=development` — `pnpm dev` and `pnpm basalt` set it themselves, so `pnpm start` loads `.env` and still runs as production (fail-closed secrets). `update` offers the new `start` to an app whose `start` is the exact previous one, swaps the 1.11–1.14 `.env.example` header, and prints a manual step when `.env` still sets `NODE_ENV=development`; `doctor` notes both.
