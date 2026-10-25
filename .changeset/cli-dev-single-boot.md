---
'@basaltkit/cli': minor
'create-basalt': minor
---

`basalt dev` is now a better `pnpm dev`:

- **It starts while the app cannot boot.** A create-basalt `bin/basalt.ts` sends `dev` to the new `runDev()` before importing the app. It boots the app only for the route table; when that fails (a variable missing, the database down, code mid-edit) it prints the reason and starts the watcher anyway, which restarts the server on every save. A boot that hangs gives up after 10 s.
- **One app per session.** The boot that reads the route table is shut down before the server starts (it kept a second database pool and every connection open for the whole session).
- **It runs `src/dev.ts` first** when present, which is what `pnpm dev` runs (`.env` and `NODE_ENV=development` before the server). Before, it ran `src/server.ts`.

`create-basalt update` patches an untouched `bin/basalt.ts` with the new `dev` block (or prints it to paste into a customised one).
