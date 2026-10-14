# @basaltkit/deploy-ui

## 0.1.2

### Patch Changes

- b64cfec: The package READMEs link to the new illustrated guide, [Deploying to a server](https://basaltkit-docs.pages.dev/guide/deploy) (English and Portuguese): a first server, everyday deploys from the terminal and the local UI, and troubleshooting. The `@basaltkit/deploy-ui` README also shows a screenshot of the Plan & deploy page.
- Updated dependencies [b64cfec]
  - @basaltkit/deploy@0.5.2

## 0.1.1

### Patch Changes

- a327caa: Visual redesign: the deploy UI now reads as an operations console. A fixed sidebar with the Basalt mark, the target selector and icon navigation (a top bar below 900px); a context strip on every screen with the target, a prominent PROTECTED badge, the ssh destination, the server host and the app; graphite design tokens with a full dark theme and one molten accent; cards, key/value grids, status pills, tables with sticky headers, findings with severity badges and the fix in a mono callout, empty states, and elevated dialogs that mark destructive actions. The run screen has a step timeline (running, ok, failed, skipped, no end seen) with durations, and a terminal-style log with time and source columns and warn/error tinting. Same CSP (no inline script or style, nothing loaded from elsewhere), same text-only rendering.
- Updated dependencies [d90a168]
- Updated dependencies [50499cf]
  - @basaltkit/deploy@0.5.1

## 0.1.0

### Minor Changes

- 5bec5b0: New package (RFC 0009): a local web UI for `@basaltkit/deploy` that runs on the operator's machine — `npx @basaltkit/deploy-ui@<exact version>` — listens on `127.0.0.1` only, and drives each server over the system `ssh` with the operator's own keys, agent and `known_hosts`, through the RFC 0008 machine protocol. Nothing is installed or started on the server.
  
  - Targets in the operator's config directory (`$XDG_CONFIG_HOME/basalt/deploy-targets.json`, `%APPDATA%` on Windows), a closed grammar per field, written 0600, never in the app repository.
  - Status, plan, the `.env` questions (secrets in password fields, sent once on ssh's stdin, never stored), a detached run with a live log that re-attaches from the next `seq` after a drop, cancel (the second one separately confirmed), rollback to a picked release, history.
  - Security: a one-time launch code in the URL fragment exchanged for one bearer session token, exact `Host`/`Origin`, a POST-only JSON API, strict CSP, no CORS, idle shutdown; `ssh` with `BatchMode=yes`, `StrictHostKeyChecking=yes`, no forwarding, `--` before the destination, and a remote command built from validated, single-quoted pieces running the app's lockfile-pinned `@basaltkit/deploy`.
  
  Never add it to an app's `package.json`: the deploy installs devDependencies on the server.

### Patch Changes

- 9cd8edb: Fixes from the independent review of the local UI (RFC 0009 §15):
  
  - **The server proves itself.** The session exchange also returns a server key that the page never sends. After every load, and before any `.env` answer leaves the page, the server must answer a fresh nonce with `HMAC-SHA256(serverKey, …)`. A process that takes the port after the UI stopped gets no answer. When the server is gone or fails the proof, the page empties its forms, forgets the `sessionStorage` session (Quit does too) and says so.
  - **Targets file ownership.** The file is refused when another user owns it, or when any directory up to `/` is owned by another user (root excepted) or writable by others without the sticky bit. Saves are checked the same way. `run`, `env` and `rollback` carry the target the confirmation showed, and if the file changed since, the server answers 409 and sends nothing.
  - **Windows.** `ssh.exe` and `rundll32.exe` are resolved to absolute paths, so a planted binary in the current folder is never run. ssh and the opener start in the home directory on every OS.
  - **Cancel.** The first cancel is sent as `cancel --first-only`. When the server says the run was already cancelled (from a terminal or an earlier UI session), the page asks for the second confirmation instead of sending the immediate signal.
  - **Attach.** A stream cut mid-line is resumed from the last complete event instead of being reported as corrupt. Re-attaching after a run has ended finishes at once with the run's exit code, where it used to reconnect for up to 10 minutes, and the page then offers only a replay.
  - **Idle shutdown** waits for a command still in flight, such as a slow plan or a run that is detaching, not only for open streams.
  - Destructive dialogs open with focus on *Cancel*. A resumed step whose start came before the resume point is named by its id.
- Updated dependencies [9cd8edb]
- Updated dependencies [d9bea2b]
- Updated dependencies [5ef14ee]
- Updated dependencies [3ebf5be]
- Updated dependencies [7490752]
  - @basaltkit/deploy@0.5.0
