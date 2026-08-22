---
"@basaltkit/cli": minor
"create-basalt": patch
---

Make `basalt dev` worth using over a bare `tsx watch`.

- **Route table on boot** — `basalt dev` now prints the app's registered HTTP routes (method, url, and an auth/rate-limit/tags flags column) before starting the server. The app is already booted by the CLI runner, so this is adapter-agnostic (reads the `http:routes` metadata). New pure `devRouteRows(routes)` (exported, tested).
- **`--worker`** — also starts a watched `queue:work` process alongside the server, so jobs process in dev without a second terminal (the real producer/worker topology; each restarts independently). `--queue=<name>` scopes it.
- **`--no-routes`** skips the table. Server watching still delegates to `tsx watch` / `node --watch`.

create-basalt: the generated `bin/basalt.ts` help now mentions `basalt dev`.
