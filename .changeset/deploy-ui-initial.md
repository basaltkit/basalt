---
'@basaltkit/deploy-ui': minor
---

New package (RFC 0009): a local web UI for `@basaltkit/deploy` that runs on the operator's machine — `npx @basaltkit/deploy-ui@<exact version>` — listens on `127.0.0.1` only, and drives each server over the system `ssh` with the operator's own keys, agent and `known_hosts`, through the RFC 0008 machine protocol. Nothing is installed or started on the server.

- Targets in the operator's config directory (`$XDG_CONFIG_HOME/basalt/deploy-targets.json`, `%APPDATA%` on Windows), a closed grammar per field, written 0600, never in the app repository.
- Status, plan, the `.env` questions (secrets in password fields, sent once on ssh's stdin, never stored), a detached run with a live log that re-attaches from the next `seq` after a drop, cancel (the second one separately confirmed), rollback to a picked release, history.
- Security: a one-time launch code in the URL fragment exchanged for one bearer session token, exact `Host`/`Origin`, a POST-only JSON API, strict CSP, no CORS, idle shutdown; `ssh` with `BatchMode=yes`, `StrictHostKeyChecking=yes`, no forwarding, `--` before the destination, and a remote command built from validated, single-quoted pieces running the app's lockfile-pinned `@basaltkit/deploy`.

Never add it to an app's `package.json`: the deploy installs devDependencies on the server.
